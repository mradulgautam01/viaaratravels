# Viaara Backend — Setup Guide

## First-time setup (local machine or EC2)

```bash
# 1. Go to the project folder
cd "Travel App"

# 2. Copy env file and fill in your values
cp .env.example .env
# Edit .env — for local dev, the defaults work as-is (SQLite + local uploads)

# 3. Install dependencies
npm install

# 4. Run database migrations (creates all tables)
node db/migrate.js

# 5. Start the server
npm run dev      # auto-restarts on file change (uses nodemon)
# or
node server.js   # plain start
```

Open http://localhost:3000 — your HTML files are served from /public/

---

## Switching to PostgreSQL (EC2 production)

In your `.env` on EC2:
```
DB_CLIENT=postgres
PG_HOST=your-rds-endpoint.amazonaws.com
PG_PORT=5432
PG_USER=viaara
PG_PASSWORD=your_secure_password
PG_DATABASE=viaara_db
```

---

## Switching to S3 storage (EC2 production)

In your `.env` on EC2:
```
STORAGE=s3
AWS_REGION=ap-south-1
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
S3_BUCKET=viaara-media
```

Install the AWS SDK on EC2:
```bash
npm install aws-sdk
```

---

## EC2 deployment steps

```bash
# On EC2 (Ubuntu):
sudo apt update
sudo apt install -y nodejs npm postgresql

# Clone or upload your project, then:
cd viaara
npm install
npm install aws-sdk   # only needed if STORAGE=s3

# Set .env for production (postgres + s3)
nano .env

# Run migrations
node db/migrate.js

# Start with PM2 (keeps it running after logout)
npm install -g pm2
pm2 start server.js --name viaara
pm2 save
pm2 startup
```

---

## Trip ID system

| State | Display | Meaning |
|-------|---------|---------|
| Active trip, no past dates | `DEH-XXXXXXX` | Prefix locked, awaiting departure |
| Departure date passed | `DEH061126A` | Instance created automatically |
| Second trip same prefix+date | `DEH061126B` | Collision handled |

The cron job runs at **00:05 every day** and also on **server startup** (to catch missed days while server was offline).

---

## Project structure

```
Travel App/
├── server.js          ← Entry point
├── package.json
├── .env               ← Your config (not in git)
├── .env.example       ← Template
├── db/
│   ├── db.js          ← SQLite/Postgres abstraction (knex)
│   └── migrate.js     ← Run once to create tables
├── lib/
│   ├── tripId.js      ← ID generator (DEH061126A logic)
│   ├── storage.js     ← Local file / S3 abstraction
│   └── cron.js        ← Auto instance creator (runs daily)
├── routes/
│   ├── trips.js       ← /api/trips
│   ├── leads.js       ← /api/leads
│   ├── analytics.js   ← /api/analytics
│   └── upload.js      ← /api/upload
└── public/
    ├── index.html
    ├── admin.html
    └── upcoming-trips.html
```
