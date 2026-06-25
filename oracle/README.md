# TenderLogix Pricing Oracle

Runs on Oracle VPS (84.8.128.245) port 3002.
Exposed via Cloudflare Tunnel as https://pricing-oracle.websitehub.co.za

## Deploy

```bash
cd /root
git clone https://github.com/pierreduplessis6912-gif/Website-hub.git repo
cp -r repo/oracle /root/oracle
cd /root/oracle
npm install
pm2 start ecosystem.json
pm2 save
```

## Update

```bash
cd /root/repo && git pull
cp -r oracle/* /root/oracle/
cd /root/oracle && pm2 restart pricing-oracle
```

## Endpoints

- GET /health — status and rate count
- GET /pricing-oracle?sector=cleaning&province=KZN — get rates
- GET /pricing-oracle/sectors — all sectors on file
- GET /pricing-oracle/fetch — trigger manual fetch (admin use)

## Sectors supported
- cleaning (BCCCI KZN, SD1 National, NCCA full cost model)
- civil_engineering (BCCEI)
- metal_engineering (MEIBC)
- motor (MIBCO)
- road_freight (NBCRFLI)
- electrical (NBCEI)
- security (NBCPSS)
- national_minimum_wage (NMW floor fallback)

## Cron
Runs monthly on the 1st at 02:00 server time.
Manual trigger: GET /pricing-oracle/fetch
