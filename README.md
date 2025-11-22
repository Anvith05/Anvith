# Trading Confluence Scanner
A small Node.js app that scans a list of markets for classic reversal patterns (M / Inverse M, Head & Shoulders / Inverse H&S) with higher‑timeframe confluence.

The backend pulls OHLC data from the Twelve Data API, computes daily and weekly EMA‑based trends, and then searches for patterns on intraday timeframes. The frontend polls the backend, shows a live table of pairs, and keeps a log of signals. Optionally, signals are stored in MongoDB for basic history.

## Tech stack
- **Backend**: Node.js, Express, Axios
- **Data**: Twelve Data time series API
- **Database (optional)**: MongoDB via Mongoose
- **Frontend**: Vanilla HTML/CSS/JS (no framework)

## Prerequisites
- Node.js (LTS version recommended)
- npm (comes with Node)
- A Twelve Data API key (free tier is enough to get started)
- (Optional) A MongoDB connection string if you want to persist signals

## 1. Project setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create your `.env` file (or edit the existing one):
   - You can use `.env.example` as a reference.
   - Required:
     - `PORT` – Port for the HTTP server (e.g. `4000`).
     - `TWELVE_DATA_API_KEY` – Your Twelve Data API key.
   - Optional:
     - `MONGODB_URI` – MongoDB connection string. If not set, the app will still run, but signals will not be stored.

Example `.env`:
```env
PORT=4000
TWELVE_DATA_API_KEY=your_real_twelve_data_key_here
MONGODB_URI=your_mongodb_connection_string_here
```

> Make sure you **never commit** your real `.env` file or API keys/DB passwords into a public repository.

## 2. Running the app locally

From the project directory:

```bash
npm start
```

If everything is configured correctly, you should see something like:

```text
Server listening on http://localhost:4000
```

Then open your browser at:

```text
http://localhost:4000/
```

Use the **Start Scanner** button at the top to start polling. The table will fill with pairs and the log pane will show new signals when they appear.

## 3. How it works (high level)

### Backend
- Exposes `GET /api/scan?symbol=SYMBOL` which:
  - Fetches higher‑timeframe candles from Twelve Data (1D and 1W).
  - Computes EMA‑based daily and weekly trend.
  - Fetches intraday candles (1h, 4h) and looks for:
    - M‑top / Inverted M
    - Head & Shoulders / Inverse Head & Shoulders
  - Only returns a signal if the pattern direction agrees with both HTF trends (confluence).
  - Optionally stores the signal in MongoDB (if `MONGODB_URI` is set).

- Exposes `GET /api/signals` which returns recent stored signals from MongoDB (or an empty array if no DB is configured).

### Frontend
- `index.html` / `style.css` render a dark‑themed dashboard.
- `app.js`:
  - Defines a list of pairs to scan.
  - Periodically calls `/api/scan` for each pair.
  - Updates the table with last price, pattern, timeframe, and 1D/1W trend badges.
  - Appends new signals to a **Live Signals Log** and refreshes a **History** list from `/api/signals`.

## 4. Customising pairs

You can edit the list of symbols in `app.js` near the top:

```js
const PAIRS = [
  { symbol: 'BTC/USD', label: 'BTCUSC' },
  // ...
];
```

- `symbol` is what is sent to the Twelve Data API.
- `label` is just what you want to see in the UI.

Make sure the `symbol` values are valid symbols for your data provider, or the scan calls will fail for those entries.

## 5. Troubleshooting

**The server exits immediately with an error about TWELVE_DATA_API_KEY**
- You must set a real Twelve Data API key in your `.env` file.

**/api/scan returns an error or status 500**
- Common causes:
  - Invalid symbol for the data provider.
  - Twelve Data API key is invalid or rate‑limited.
- Check the server logs in your terminal for the exact message.

**MongoDB connection errors**
- If you do not need persistence, you can remove or comment out `MONGODB_URI` from your `.env` file. The app will skip MongoDB and still run.
- If you do want persistence, verify:
  - The username/password are correct.
  - Your IP is allowed in your MongoDB Atlas (or equivalent) network settings.

## 6. Production notes (high level)

This project is intended as a learning/utility tool, not a fully hardened production service. If you want to deploy it:

- Use environment variables (never hard‑code secrets).
- Put it behind a reverse proxy (Nginx, etc.) with HTTPS.
- Add logging/monitoring around API failures and rate limits.
- Consider adding rate‑limiting and input validation on the `/api/scan` endpoint.

Always treat the output as informational only – it is **not financial advice**.
