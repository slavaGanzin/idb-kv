class Idbkv {
  constructor (dbName, {batchInterval} = {batchInterval: 10}) {
    this.storeName = 'idb-kv'
    this.batchInterval = batchInterval

    // Promise for the indexeddb DB object
    this.db = new Promise((resolve, reject) => {
      let request = window.indexedDB.open(dbName, 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)

      // if db doesn't already exist
      request.onupgradeneeded = () => request.result.createObjectStore(this.storeName)
    })

    this._actions = []
    // ^^ A list of pending actions for the next batch transaction
    // {
    //   type: (set, get, or delete)
    //   key:
    //   value:
    //   resolve: (resolve get() promise)
    //   reject: (reject get() promise)
    //   request: (pending ObjectStoreRequest for get())
    // }

    this.closed = false

    // promise for the completion of the next batch transaction
    this._batchPromise = new Promise((resolve, reject) => {
      this._resolveBatch = resolve
      this._rejectBatch = reject
    })

    // promise for the return value from setInterval for batching
    this._batchTimer = this._startBatchTimer()
  }
  // returns promise
  get (key) {
    if (this.closed) throw new Error('This Idbkv instance is closed')
    return new Promise((resolve, reject) => {
      this._actions.push({
        type: 'get',
        key: key,
        resolve: resolve,
        reject: reject
      })
    })
  }
  // returns promise
  set (key, value) {
    if (this.closed) throw new Error('This Idbkv instance is closed')
    this._actions.push({
      type: 'set',
      key: key,
      value: value
    })
    return this._batchPromise
  }
  // returns promise
  delete (key) {
    if (this.closed) throw new Error('This Idbkv instance is closed')
    this._actions.push({
      type: 'delete',
      key: key
    })
    return this._batchPromise
  }
  async close () {
    this.closed = true

    clearInterval(await this._batchTimer)

    let db = await this.db

    // commit any leftover pending actions
    // db.close() will wait for the transaction to complete
    this._commit(db)

    db.close()
  }
  async destroy () {
    await this.close()

    // the deletion will wait for db.close() to finish even if it's waiting for a transaction
    let request = window.indexedDB.deleteDatabase((await this.db).name)
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }
  async _startBatchTimer () {
    let db = await this.db

    // wrapping _commit() in an arrow function is necessary to preserve lexical scope
    return setInterval(() => this._commit(db), this.batchInterval)
  }
  // commit all of the pending gets, sets, and deletes to the db
  _commit (db) {
    if (this._actions.length === 0) return

    let commitedActions = this._actions
    this._actions = []

    let resolveBatch = this._resolveBatch
    let rejectBatch = this._rejectBatch
    this._batchPromise = new Promise((resolve, reject) => {
      this._resolveBatch = resolve
      this._rejectBatch = reject
    })

    let transaction = db.transaction(this.storeName, 'readwrite')
    let store = transaction.objectStore(this.storeName)

    for (let action of commitedActions) {
      switch (action.type) {
        case 'get':
          let request = store.get(action.key)
          request.onsuccess = () => {
            let value = request.result
            if (value === undefined) {
              action.reject(new Error(`Key:${action.key} does not exist in db:${db.name}`))
            } else {
              action.resolve(value)
            }
          }
          break
        case 'set':
          store.put(action.value, action.key)
          break
        case 'delete':
          store.delete(action.key)
          break
      }
    }

    transaction.oncomplete = () => resolveBatch()

    transaction.onerror = transaction.onabort = (error) => {
      // onabort uses an argument to pass the error, but onerror uses transaction.error
      rejectBatch(transaction.error || error)
    }
  }
}

module.exports = Idbkv
