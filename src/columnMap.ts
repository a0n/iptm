// tslint:disable:no-if-statement no-object-mutation no-expression-statement no-shadowed-variable readonly-array
// tslint:disable:array-type no-delete no-let no-console
import * as shajs from 'sha.js'
import { toCbor } from './cbor'
import { CompressedArray, DagArray } from './dagArray'

export type ColumnMap<T> = {
  indices?: ReadonlyArray<number>
  values?: ReadonlyArray<T>
  children?: { [key: string]: ColumnMap<T> }
}
type ColumnMapImpl<T> = {
  indices: Array<number>
  values: Array<T>
  children: { [key: string]: ColumnMapImpl<T> }
}
const stripInPlace = <T>(store: ColumnMapImpl<T>): ColumnMap<T> => {
  if (store.values.length !== store.indices.length) {
    throw new Error()
  }
  if (store.values.length === 0) {
    delete store.values
    delete store.indices
  }
  const children = Object.values(store.children)
  if (children.length === 0) {
    delete store.children
  } else {
    children.forEach(stripInPlace)
  }
  return store
}
const getCompressedSize = async (m: ColumnMap<any>): Promise<number> => {
  let result = 0
  if (m.indices !== undefined && m.values !== undefined) {
    // enable delta compression for indices
    result += await DagArray.getCompressedSize(m.indices, { forceDelta: true })
    // let the compressor figure out if delta compression makes sense
    result += await DagArray.getCompressedSize(m.values)
  }
  if (m.children !== undefined) {
    for (const child of Object.values(m.children)) {
      result += await getCompressedSize(child)
    }
  }
  return result
}
const sha1 = (buffer: Buffer): string => {
  return shajs('sha1')
    .update(buffer.toString('hex'))
    .digest('hex')
}
const getBufferForSizing = (x: DagArray): Promise<Buffer> => {
  if (Array.isArray(x)) {
    return toCbor(x)
  } else {
    const ca = x as CompressedArray
    // not exactly accurate, since we would have to add the
    // compression type and reference in case of delta compression.
    // also, we assume that cbor dag will store a buffer without overhead
    // (no base64 or anything)
    return Promise.resolve(ca.d)
  }
}
const compressedSizeDedupImpl = async (
  m: ColumnMap<any>,
  sizes: { [key: string]: number },
): Promise<{ [key: string]: number }> => {
  if (m.indices !== undefined && m.values !== undefined) {
    // enable delta compression for indices
    const indices = await DagArray.compress(m.indices, { forceDelta: true })
    const values = await DagArray.compress(m.values)
    const ib = await getBufferForSizing(indices)
    const vb = await getBufferForSizing(values)
    sizes[sha1(ib)] = ib.length
    sizes[sha1(vb)] = vb.length
  }
  if (m.children !== undefined) {
    for (const child of Object.values(m.children)) {
      await compressedSizeDedupImpl(child, sizes)
    }
  }
  return sizes
}
const getCompressedSizesDedup = (m: ColumnMap<any>): Promise<number> =>
  compressedSizeDedupImpl(m, {}).then(sizes => {
    console.log(sizes)
    return Object.values(sizes).reduce((x, y) => x + y, 0)
  })

export const ColumnMap = {
  compressedSize: getCompressedSize,
  compressedSizeDedup: getCompressedSizesDedup,
}
const ColumnMapImpl = {
  /**
   * Creates a new empty column map.
   * We are using mutability, so everything needs to be fresh.
   */
  empty: <T>(): ColumnMapImpl<T> => ({
    indices: [],
    values: [],
    children: {},
  }),
  /**
   * Strips unused fields in place and returns the thing as a ColumnStore, never
   * to be mutated again
   */
  build: stripInPlace,
}

const getOrCreateInPlace = <T>(store: ColumnMapImpl<T>, key: string): ColumnMapImpl<T> => {
  const result = store.children[key]
  if (result !== undefined) {
    return result
  } else {
    const child = ColumnMapImpl.empty<T>()
    store.children[key] = child
    return child
  }
}

const isPrimitive = (key: any): boolean => {
  if (key === null) {
    return true
  }
  const type = typeof key
  if (type === 'function') {
    throw new Error('What do you think this is? unisonweb.org?')
  }
  if (type === 'object') {
    return false
  }
  return true
}

const updateInPlace = (obj: any, path: ReadonlyArray<string>, from: number, value: any): any => {
  if (from === path.length) {
    // at the end, just return the value and let the caller deal with storing it
    return value
  } else {
    const key = path[from]
    const child = obj[key]
    const childExists = child !== undefined
    const child1 = childExists ? child : {}
    const child2 = updateInPlace(child1, path, from + 1, value)
    // if the column store is canonical, I will never overwrite a scalar value,
    // and the from === path.length - 1 test is not necessary. But let's accept
    // non-canonical formats as well
    const mustUpdate = from === path.length - 1 || !childExists
    if (mustUpdate) {
      obj[key] = child2
    }
    return obj
  }
}

export const fromColumnMap = <T>(columns: ColumnMap<T>): ReadonlyArray<T> => {
  const rows: any = {}
  // first position is placeholder for the current index
  const path: Array<any> = [undefined]
  const addToRows = (store: ColumnMap<T>): void => {
    if (store.values !== undefined && store.indices !== undefined) {
      const indices = store.indices
      const values = store.values
      if (values.length !== indices.length) {
        throw new Error()
      }
      for (let i = 0; i < store.values.length; i++) {
        const index = indices[i]
        const value = values[i]
        path[0] = index
        updateInPlace(rows, path, 0, value)
      }
    }
    if (store.children !== undefined) {
      const children = store.children
      Object.entries(children).forEach(([key, childStore]) => {
        path.push(key)
        addToRows(childStore)
        path.pop()
      })
    }
  }
  addToRows(columns)
  return Object.values(rows)
}

export const toColumnMap = <T>(rows: ReadonlyArray<T>): ColumnMap<T> => {
  const rootStore: ColumnMapImpl<T> = ColumnMapImpl.empty()
  const addToValuesAndIndices = (store: ColumnMapImpl<any>, obj: any, index: number): void => {
    if (isPrimitive(obj)) {
      store.indices.push(index)
      store.values.push(obj)
    } else {
      Object.entries(obj).forEach(([key, value]) => {
        const childStore = getOrCreateInPlace(store, key)
        addToValuesAndIndices(childStore, value, index)
      })
    }
  }
  rows.forEach((row, index) => {
    addToValuesAndIndices(rootStore, row, index)
  })
  return ColumnMapImpl.build<T>(rootStore)
}