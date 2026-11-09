/**
 * db.js — Database abstraction layer
 * Locally:     SQLite via better-sqlite3
 * Production:  PostgreSQL via pg
 *
 * Uses knex as query builder — same API regardless of engine.
 * Switch by setting DB_CLIENT=sqlite or DB_CLIENT=postgres in .env
 */

require('dotenv').config();
const knex = require('knex');
const path = require('path');

const client = process.env.DB_CLIENT || 'sqlite';

let config;

if (client === 'sqlite') {
  config = {
    client: 'better-sqlite3',
    connection: {
      filename: path.resolve(process.env.SQLITE_PATH || './db/viaara.sqlite'),
    },
    useNullAsDefault: true,
  };
} else {
  // PostgreSQL — used on EC2
  config = {
    client: 'pg',
    connection: {
      host:     process.env.PG_HOST     || 'localhost',
      port:     parseInt(process.env.PG_PORT || '5432'),
      user:     process.env.PG_USER     || 'viaara',
      password: process.env.PG_PASSWORD || '',
      database: process.env.PG_DATABASE || 'viaara_db',
    },
    pool: { min: 2, max: 10 },
  };
}

const db = knex(config);

module.exports = db;
