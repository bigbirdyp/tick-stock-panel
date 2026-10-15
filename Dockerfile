# 多阶段构建:前端静态产物 + FastAPI/内部交易日志 Node, 单容器仅公开 3018
# 可选:构建网络无法直连官方源时,传入 --build-arg USE_CN_MIRROR=1 启用国内镜像
ARG USE_CN_MIRROR=1
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG PYPI_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
# 备用 PyPI 源:主源同步延迟/故障时自动兜底(阿里云与清华互为补充)
ARG PYPI_FALLBACK=https://mirrors.aliyun.com/pypi/simple
ARG BACKEND_EXTRAS=
ARG CODEX_CLI_VERSION=0.144.3

# === Stage 1: 前端构建 ===
FROM node:20-alpine AS frontend-builder
ARG USE_CN_MIRROR=1
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /build
# 关键:corepack 不读 npm 的 registry 配置,且跨 RUN 不保留环境变量,
# 因此国内网络下最稳的做法是直接用 npm 安装 pnpm(npm 会读取 .npmrc 镜像源),
# 彻底绕开 corepack 再次联网下载 pnpm 的问题。
RUN if [ "$USE_CN_MIRROR" = "1" ]; then npm config set registry "$NPM_REGISTRY"; fi && \
    npm install -g pnpm@9
# 让 pnpm 走镜像源安装依赖
RUN if [ "$USE_CN_MIRROR" = "1" ]; then pnpm config set registry "$NPM_REGISTRY"; fi
COPY frontend/package.json frontend/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY frontend/ ./
RUN pnpm build

# === Stage 1c: Codex CLI ===
# 固定版本保证镜像可复现；只复制安装产物到运行镜像，不保留 npm。
FROM node:20-bookworm-slim AS codex-builder
ARG USE_CN_MIRROR=1
ARG NPM_REGISTRY=https://registry.npmmirror.com
# 版本由顶层 ARG CODEX_CLI_VERSION 提供, 这里仅声明以继承, 不再重复默认值。
ARG CODEX_CLI_VERSION
RUN if [ "$USE_CN_MIRROR" = "1" ]; then npm config set registry "$NPM_REGISTRY"; fi \
    && npm install --global --prefix /opt/codex "@openai/codex@${CODEX_CLI_VERSION}" \
    && CODEX_NATIVE="$(find /opt/codex -type f -path '*/vendor/*/bin/codex' -print -quit)" \
    && test -n "$CODEX_NATIVE" \
    && cp "$CODEX_NATIVE" /opt/codex-native \
    && chmod +x /opt/codex-native \
    && /opt/codex-native --version

# === Stage 1j: 交易日志 Node 运行时 ===
# 使用 Debian/glibc 二进制；Alpine/musl 的 Node 不能直接复制到 Python slim。
FROM node:24-bookworm-slim AS journal-runtime

# === Stage 2: Python + Node 运行时 ===
FROM python:3.11-slim AS runtime
ARG USE_CN_MIRROR=1
ARG PYPI_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
ARG PYPI_FALLBACK=https://mirrors.aliyun.com/pypi/simple
ARG BACKEND_EXTRAS=
WORKDIR /app

# Codex CLI 从官方 npm 包提取原生二进制，不依赖运行时 Node.js。
# 国内构建换 apt 阿里云镜像 (bookworm deb822 格式)。官方 python slim 镜像的
# sources 指向 deb.debian.org, 部分国内网络下 apt 极慢(实测阿里云 ECS 拉官方源
# 单阶段可达 8 分钟以上); USE_CN_MIRROR 与 npm/pypi 的换源开关注一脉相承。
# tesseract-ocr: 自选截图导入（始终安装）
RUN if [ "$USE_CN_MIRROR" = "1" ]; then \
        sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null || true; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng libstdc++6 libatomic1 \
    && rm -rf /var/lib/apt/lists/* \
    && tesseract --version

# 交易日志没有 npm 依赖；运行镜像只需要 Node 可执行文件。
COPY --from=journal-runtime /usr/local/bin/node /usr/local/bin/node
RUN node --version

# 安装 uv(快) —— 国内镜像下三重兜底:主源 → 备用源 → 官方源,
# 任一成功即可,避免单一镜像同步延迟/故障导致构建失败。
# uv 发版极频繁,国内镜像同步存在时间窗口,不锁版本且无 fallback 时
# 容易遇到 "from versions: none"(索引解析不到最新版)。
RUN if [ "$USE_CN_MIRROR" = "1" ]; then \
      pip install --no-cache-dir uv -i "$PYPI_INDEX" || \
      pip install --no-cache-dir uv -i "$PYPI_FALLBACK" || \
      pip install --no-cache-dir uv; \
    else \
      pip install --no-cache-dir uv; \
    fi

# Backend deps
COPY README.md /README.md
COPY backend/pyproject.toml backend/uv.lock* ./
# uv 原生支持同时挂多个 index(主源 + 备用源),会自动在两源中查找,
# 比逐个重试更稳健 —— 任一源缺包时另一源补位。
RUN if [ "$USE_CN_MIRROR" = "1" ]; then \
      export UV_DEFAULT_INDEX="$PYPI_INDEX" UV_EXTRA_INDEX_URL="$PYPI_FALLBACK"; \
    fi; \
    set -- --no-dev; \
    for extra in $BACKEND_EXTRAS; do \
      set -- "$@" --extra "$extra"; \
    done; \
    uv sync --frozen "$@" || uv sync "$@"

# Backend code
# 注意:Docker 里 WORKDIR=/app, 而 config.py 的 _PROJECT_ROOT 是按开发布局
# (<root>/backend/app/) 推导的, 容器内会错算到 /。这里用环境变量显式指定
# 三个关键路径, 确保 static / tiers / data 都指向容器内正确位置。
COPY backend/app ./app
COPY backend/trade-journal-node/package.json /app/trade-journal-node/package.json
COPY backend/trade-journal-node/src /app/trade-journal-node/src
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN node --check /app/trade-journal-node/src/index.js
COPY tiers.yaml /app/tiers.yaml
ENV STATIC_DIR=/app/static \
    TIERS_YAML=/app/tiers.yaml \
    DATA_DIR=/app/data \
    TICKFLOW_ENV_FILE=/app/.env \
    PORT=3018 \
    TRADE_JOURNAL_PORT=3022 \
    TRADE_JOURNAL_DATA_FILE=/app/data/trade-journal/journal.json

# Frontend 静态产物
COPY --from=frontend-builder /build/dist ./static

# Codex CLI 使用官方 npm 包携带的当前平台原生二进制，无需运行时 Node.js。
COPY --from=codex-builder /opt/codex-native /usr/local/bin/codex
RUN codex --version

ENV PYTHONPATH=/app
# 保留与构建期一致的 uv 源配置；入口使用 --no-sync，启动时不改依赖或锁文件。
ARG PYPI_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
ARG PYPI_FALLBACK=https://mirrors.aliyun.com/pypi/simple
ENV UV_DEFAULT_INDEX=${PYPI_INDEX} \
    UV_EXTRA_INDEX_URL=${PYPI_FALLBACK}
# 兜底时区: 交易时段判断已在代码里显式用北京时间 (app/market_time.py),
# 此处让日志时间戳等其余 naive 时间也对齐北京时间。
ENV TZ=Asia/Shanghai
EXPOSE 3018
CMD ["/bin/sh", "/app/docker-entrypoint.sh"]
