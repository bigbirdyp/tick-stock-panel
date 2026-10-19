import { expect, it } from 'vitest'
import { indexStockNames, segmentReviewContent, type ReviewSegment } from './reviewStocks'

const aliases = [{ code: '600519', symbol: '600519.SH', name: '贵州茅台' }]
const names = indexStockNames(aliases)

function joined(segments: ReviewSegment[]) {
  return segments.map(segment => segment.text).join('')
}

it('名称、两个六位代码和规范 symbol 可识别，拼回仍是原文', () => {
  const content = '今天买入贵州茅台，关注600519，000001\n600519.SH 备注'
  const segments = segmentReviewContent(content, names)
  expect(joined(segments)).toBe(content)
  expect(segments.filter(segment => segment.kind === 'stock')).toEqual([
    { kind: 'stock', text: '贵州茅台', symbol: '600519.SH', name: '贵州茅台', via: 'name' },
    { kind: 'stock', text: '600519', symbol: '600519.SH', name: '贵州茅台', via: 'code' },
    { kind: 'stock', text: '000001', symbol: '000001.SZ', name: '', via: 'code' },
    { kind: 'stock', text: '600519.SH', symbol: '600519.SH', name: '贵州茅台', via: 'symbol' },
  ])
})

it('长数字、标识符、金额、错误后缀和未知名称不产生股票', () => {
  const content = '16005190 abc600519x 600519.25 ￥600519 000001.SH 未知公司'
  const segments = segmentReviewContent(content, names)
  expect(joined(segments)).toBe(content)
  expect(segments.some(segment => segment.kind === 'stock')).toBe(false)
})
