// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolveTraderSelection } from './traderTabs'
import type { TraderSummary } from './types'

function trader(name: string, recordCount: number): TraderSummary {
  return { trader: name, record_count: recordCount, review_count: 0 }
}

// 三人名字各不相同：榜首记录最多，记忆人居中，链接人最少。
const roster = [trader('榜首', 10), trader('记忆人', 3), trader('链接人', 1)]

describe('resolveTraderSelection', () => {
  it('没有交易者时没有选中值，地址栏和已保存名字都不能凭空造一个', () => {
    expect(resolveTraderSelection([], '链接人', '记忆人')).toBeUndefined()
    expect(resolveTraderSelection([], null, '记忆人')).toBeUndefined()
    expect(resolveTraderSelection([], '', null)).toBeUndefined()
    expect(resolveTraderSelection([], null, null)).toBeUndefined()
  })

  it('地址栏给出空白时落到第一人，不读已保存值', () => {
    expect(resolveTraderSelection(roster, '', '记忆人')).toBe('榜首')
    expect(resolveTraderSelection(roster, '   ', '记忆人')).toBe('榜首')
    expect(resolveTraderSelection(roster, '\n\t', '记忆人')).toBe('榜首')
  })

  it('地址栏缺席时才采用已保存的合法名字', () => {
    expect(resolveTraderSelection(roster, null, '记忆人')).toBe('记忆人')
    expect(resolveTraderSelection(roster, null, '  记忆人  ')).toBe('记忆人')
  })

  it('地址栏缺席且已保存值为空白或未知时落到第一人', () => {
    expect(resolveTraderSelection(roster, null, null)).toBe('榜首')
    expect(resolveTraderSelection(roster, null, '')).toBe('榜首')
    expect(resolveTraderSelection(roster, null, '   ')).toBe('榜首')
    expect(resolveTraderSelection(roster, null, '已删除')).toBe('榜首')
  })

  it('地址栏参数在场且合法时选中它，盖过已保存值和第一人', () => {
    expect(resolveTraderSelection(roster, '链接人', '记忆人')).toBe('链接人')
    expect(resolveTraderSelection(roster, '  链接人  ', '记忆人')).toBe('链接人')
    expect(resolveTraderSelection(roster, '记忆人', '链接人')).toBe('记忆人')
  })

  it('地址栏指向未知或已删除的交易者时落到第一人，不读已保存值', () => {
    expect(resolveTraderSelection(roster, '不存在', '记忆人')).toBe('榜首')
    expect(resolveTraderSelection(roster, '已删除', '记忆人')).toBe('榜首')
  })

  it('不把「全部」加进候选；只有名单里真有这个名字才选得中', () => {
    expect(resolveTraderSelection(roster, '全部', '记忆人')).toBe('榜首')
    expect(resolveTraderSelection([trader('全部', 1), trader('榜首', 4)], '全部', null)).toBe('全部')
  })

  it('记录数相同时按 UTF-16 码元升序取第一人，不按传入顺序，也不看已保存值', () => {
    // 传入顺序里 b 在前；同为 4 条时 a 的码元更小，所以第一人是 a。
    const tied = [trader('b', 4), trader('a', 4), trader('c', 1)]
    expect(resolveTraderSelection(tied, '没有这个人', 'b')).toBe('a')
    expect(resolveTraderSelection(tied, null, '没有保存')).toBe('a')
  })

  it('解析不改动传入的名册顺序', () => {
    const traders = [trader('b', 1), trader('a', 2)]
    expect(resolveTraderSelection(traders, null, null)).toBe('a')
    expect(traders.map(item => item.trader)).toEqual(['b', 'a'])
  })
})
