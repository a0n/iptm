// tslint:disable:no-if-statement no-expression-statement no-shadowed-variable readonly-array
// tslint:disable:array-type no-console
import * as fs from 'fs'
import { toCbor } from './cbor'
import { ColumnMap, fromColumnMap, toColumnMap } from './columnMap'
import { deflate } from './dagArray'
import { logCompression } from './logCompression'

const roundtrip = <T>(rows: ReadonlyArray<T>): ReadonlyArray<T> => fromColumnMap(toColumnMap(rows))
const rand = (n: number): number => {
  if (n <= 0 || !Number.isSafeInteger(n)) {
    throw new Error()
  }
  return Math.floor(Math.random() * n)
}

const createSample = (_: any, i: number) => ({
  semantics: 'someFish', // constant
  name: 'fish1', // constant
  sourceId: 'asafjsiodfuhgildkh', // constant
  sequence: i + 1, // regular => constant
  timestamp: i * 1000 + rand(16), // 4 bits
  payload: {
    type: 'sample', // constant
    value: rand(16), // 4 bits
    status: rand(2) === 0, // 1 bit
  },
})
const sampleBits = 9

describe('overall compression', () => {
  const n = 100000
  const rows = Array.from({ length: n }, createSample)
  it('should be reversible', () => {
    expect(roundtrip(rows)).toEqual(rows)
  })
  it('should compress well', () => logCompression(rows, sampleBits, 'test.csv'), 60000)
})