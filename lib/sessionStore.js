/**
 * lib/sessionStore.js — express-session store backed by the existing Knex DB.
 * Only creates its own `app_sessions` table (if missing); never touches business tables.
 */

const session = require('express-session');

const TABLE = 'app_sessions';

class KnexSessionStore extends session.Store {
  constructor(db, { ttlMs = 8 * 60 * 60 * 1000, cleanupMs = 15 * 60 * 1000 } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this.cleanupMs = cleanupMs;
  }

  // Idempotent: concurrent/repeated calls share one initialization.
  init() {
    if (!this._initPromise) {
      this._initPromise = this._init().catch(err => {
        this._initPromise = null; // allow a retry after a failure
        throw err;
      });
    }
    return this._initPromise;
  }

  async _init() {
    if (!(await this.db.schema.hasTable(TABLE))) {
      try {
        await this.db.schema.createTable(TABLE, t => {
          t.string('sid', 255).primary();
          t.text('sess').notNullable();
          t.bigInteger('expires').notNullable().index();
        });
      } catch (err) {
        // Another process may have created the table between the check and the create.
        if (!(await this.db.schema.hasTable(TABLE))) throw err;
      }
    }
    await this._cleanup();
    this._timer = setInterval(() => {
      this._cleanup().catch(err => {
        console.error('[sessionStore] Expired session cleanup failed:', err.message);
      });
    }, this.cleanupMs);
    this._timer.unref();
  }

  _cleanup() {
    return this.db(TABLE).where('expires', '<=', Date.now()).del();
  }

  _expiry(sess) {
    const exp = sess && sess.cookie && sess.cookie.expires;
    const t = exp ? new Date(exp).getTime() : NaN;
    return Number.isFinite(t) ? t : Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    this.db(TABLE).where({ sid }).first().then(row => {
      if (!row) return cb(null, null);
      if (Number(row.expires) <= Date.now()) {
        return this.db(TABLE).where({ sid }).del().then(() => cb(null, null), cb);
      }
      let sess;
      try {
        sess = JSON.parse(row.sess);
      } catch (e) {
        // Corrupt row: remove it so it isn't re-read, then treat as no session.
        return this.db(TABLE).where({ sid }).del().then(() => cb(null, null), cb);
      }
      cb(null, sess);
    }).catch(cb);
  }

  set(sid, sess, cb = () => {}) {
    const row = { sid, sess: JSON.stringify(sess), expires: this._expiry(sess) };
    this.db(TABLE).insert(row)
      .onConflict('sid').merge(['sess', 'expires'])
      .then(() => cb(null), cb);
  }

  touch(sid, sess, cb = () => {}) {
    this.db(TABLE).where({ sid }).update({ expires: this._expiry(sess) })
      .then(() => cb(null), cb);
  }

  destroy(sid, cb = () => {}) {
    this.db(TABLE).where({ sid }).del().then(() => cb(null), cb);
  }
}

module.exports = KnexSessionStore;
