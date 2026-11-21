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

# 4. Run database migrations before starting the server
node db/migrate.js
node db/migrate_trip_cols.js
node db/migrate_bookings.js

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
node db/migrate_trip_cols.js
node db/migrate_bookings.js

# Start with PM2 (keeps it running after logout)
npm install -g pm2
pm2 start server.js --name viaara
pm2 save
pm2 startup
```

---

## Trip ID system

Publishing requires a departure date and duration. Each published departure gets an
ID such as `MAN-271126-01`: destination prefix, date in DDMMYY format, and an
itinerary number. The inventory shows a date-specific ID when there is one
departure, or a placeholder such as `MAN-XXXXXXX` when there are multiple dates.
Departure Occupancy shows a group only after it has received a booking; each
booking still gets its date-specific ID. A group remains visible if its bookings
are later deleted.

Admins can mark a departure group full in **Bookings → Departure Occupancy**.
When the next booking arrives for that departure, the first group becomes
`MAN-271126-01A` and the new group becomes `MAN-271126-01B`. The first group's
booking IDs are renamed to include `A`. Bookings and group status are stored
in the shared database; old browser-local test bookings are not migrated.

Full groups become completed after their final trip day. The completion job
runs at **00:05 India time** and on server startup; marking a group full also
runs the check immediately.

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
│   ├── migrate.js     ← Create base tables
│   ├── migrate_trip_cols.js
│   └── migrate_bookings.js ← Create departure groups and shared booking fields
├── lib/
│   ├── departures.js  ← Departure IDs and date validation
│   ├── storage.js     ← Local file / S3 abstraction
│   └── cron.js        ← Auto instance creator (runs daily)
├── routes/
│   ├── trips.js       ← /api/trips
│   ├── bookings.js    ← /api/bookings
│   ├── leads.js       ← /api/leads
│   ├── analytics.js   ← /api/analytics
│   └── upload.js      ← /api/upload
└── public/
    ├── index.html
    ├── admin.html
    └── upcoming-trips.html
```
