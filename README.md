# Deck — API

Express + TypeScript REST API on MongoDB (Mongoose). Serves
[`Deck-Frontend`](https://github.com/walixo/Deck-Frontend), which is where the
product, the design system and the fuller README live.

- [`DEPLOY.md`](DEPLOY.md) — going to production: hosting shape, environment,
  and what will bite
- [`render.yaml`](render.yaml) — the Render Blueprint this deploys from

## Running it

Needs Node 20+ (pinned in `.nvmrc`) and a MongoDB instance — a local `mongod`
is fine.

```bash
npm install
cp .env.example .env
npm run seed     # wipes the database and loads demo data — never against production
npm run dev
```

Serves `http://localhost:4200`. The frontend's Vite proxy points at that port,
so in development the browser stays on one origin and never meets CORS.

Every seeded account uses the password `deck1234`; `ada@deck.dev` is staff.

## Scripts

| | |
| --- | --- |
| `npm run dev` | Watch mode via `tsx` |
| `npm run build` | `tsc` to `dist/` |
| `npm start` | Runs `dist/server.js` — what production uses |
| `npm run seed` | **Destructive.** Wipes and reloads demo data |
| `npm run create-admin` | Promote an account to staff |
| `npm run check:cloudinary` | Real round trip against the image CDN |

Several scripts have a `:prod` twin — `create-admin:prod`,
`check:cloudinary:prod`. Those run the compiled JavaScript instead of the
TypeScript, because `tsx` is a devDependency and is not installed on the server.
Reaching for the wrong one there gives you `tsx: not found`.

## Configuration

Everything is in `.env.example`, which is the reference. Four things are worth
knowing without reading it:

- **The server refuses to start in production** without `JWT_SECRET` and
  `MONGODB_URI`, and rejects a `JWT_SECRET` that is the development default or
  shorter than 32 characters. A server that will not start is noticed in the
  first minute; one that signs tokens with a published secret is not noticed at
  all.
- **Images go to Cloudinary** when its three keys are set, and to `UPLOAD_DIR`
  on local disk when they are not. All three or none — a partial answer is a
  typo and is refused.
- **`TRUST_PROXY`** only when something really does sit in front of Node.
  Without a proxy, trusting `X-Forwarded-For` lets any client claim any IP.
- **Paystack** is optional. Without a secret key the shop runs but cannot take
  card payments.

## One generated file comes from the other repo

`src/config/palette.generated.ts` holds the accent colours for the embeddable
SVG badge, which is served into other people's pages and so cannot reach a
stylesheet. It is generated from `design/tokens.json` **in the frontend repo**
by `npm run tokens` there, which writes it across into this one when the two are
checked out side by side.

It is committed here rather than built here. It changes only when the palette
does — rarely, and deliberately — so a stale copy shows up in a diff instead of
lurking in a build step.
