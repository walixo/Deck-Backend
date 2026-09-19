# Deploying Deck

Frontend on Vercel, API and database elsewhere.

```
                  ┌─────────────────────────┐
  browser ───────▶│ Vercel                  │
                  │  · the built SPA        │
                  │  · /api/*     ─┐        │
                  │  · /uploads/* ─┤ rewrite│
                  └────────────────┼────────┘
                                   ▼
                  ┌─────────────────────────┐      ┌──────────────┐
                  │ API host (Node 20+)     │─────▶│ MongoDB      │
                  │  · Express, one process │      │ (Atlas)      │
                  │  · uploads on disk      │      └──────────────┘
                  └─────────────────────────┘
```

## How the frontend reaches the API

Set **`VITE_API_BASE_URL`** in the Vercel project to the API's origin, with no
`/api` on the end:

```
VITE_API_BASE_URL=https://deck-backend-9js1.onrender.com
```

Vite inlines it at **build** time, so it has to be set where the build runs and
changing it means redeploying. Requests then go straight to Render.

Leave it unset and the app calls a relative `/api` instead, which `vercel.json`
rewrites to the same host. Both work; the difference is who does the hop.

| | `VITE_API_BASE_URL` set | unset |
| --- | --- | --- |
| Request path | Browser → Render | Browser → Vercel edge → Render |
| CORS | Required | None |
| Latency | One hop | Two |

Either way `vercel.json` keeps a `/uploads/*` rewrite pointing at the API. New
images are absolute Cloudinary URLs and never use it, but a record written
before Cloudinary — or a development database — stores `"/uploads/6f2a….png"`,
and that path has to resolve to something.

### Pointing local development at the deployed API

Set `VITE_API_BASE_URL` in the frontend's `.env` and `npm run dev` calls Render
directly, so DevTools shows the real backend URLs instead of `localhost` — which
is the whole reason to do it. The Vite proxy is bypassed.

For that to work, `CLIENT_ORIGIN` on Render has to include the dev origin:

```
CLIENT_ORIGIN=https://your-app.vercel.app,http://localhost:3000
```

**The Vercel domain must stay first.** `clientOrigins[0]` is what the share kit
uses to build `pageUrl` — the link makers copy — so putting localhost in front
of it hands every maker a link to a machine that is not on the internet.

Two things to expect. Every request carries an `Authorization` header, so each
one is preflighted: an `OPTIONS` round trip to Render before the real call, and
on a cold instance that is slow. And allowing a localhost origin in production
means anyone running a dev server on that port can call the API from a browser —
harmless while the API still demands a bearer token, but worth removing once you
stop needing it.

To go back to a local API, comment `VITE_API_BASE_URL` out. The app falls back
to a relative `/api` and Vite proxies it to `:4200`.

### CORS is load-bearing in the first mode

Going direct means the browser sends an `Origin` header the API has to accept,
so **`CLIENT_ORIGIN` on Render must name the Vercel domain** or every request
is blocked. The `Authorization` header also makes each call a preflighted one,
so the API answers an `OPTIONS` first — `cors()` handles that, verified
returning 204 with the right headers.

A rejected origin answers without the allow header rather than erroring. That
matters for debugging: it used to throw, which the error handler turned into a
500, so a typo in `CLIENT_ORIGIN` looked like the server had fallen over
instead of like a configuration mistake.

## 1. Vercel

Point the project at the [`Deck-Frontend`](https://github.com/walixo/Deck-Frontend)
repository. Its `vercel.json` carries the build config, the SPA fallback, cache
headers for hashed assets, and the security headers.

That repo builds on its own, with nothing above it — a property worth keeping.
It was briefly not true: `/styleguide` imported `design/tokens.json` from
outside the project, which worked on a developer machine and failed on Vercel,
where only the repo is uploaded. `design/` and the token tooling now live
*inside* the frontend repo, and anything crossing a repository boundary has to
arrive as a **generated file that is committed** — the way this repo's
`src/config/palette.generated.ts` does. Run `npm run tokens` in the frontend
after changing `design/tokens.json`, and commit what it writes in both repos.

Edit the two `REPLACE-WITH-YOUR-API-HOST` placeholders in that file to your API
origin before the first deploy.

Environment variables (optional — leave unset and Deck makes no third-party
request, and the consent banner does not appear because there is nothing to
consent to):

| Variable | Notes |
| --- | --- |
| `VITE_API_BASE_URL` | The API origin, no `/api` suffix. See above |
| `VITE_ADSENSE_CLIENT` | Optional. `ca-pub-…` |
| `VITE_ADSENSE_SLOT` | Optional. Both must be set for any unit to appear |

## 2. API host — Render

`render.yaml` sits beside this file at the root of *this* repository, which is
what Render clones. It is a Blueprint: Render reads the service definition, the
build and start commands, the health check and the environment keys from it
rather than from dashboard clicks. `JWT_SECRET` is generated by Render;
everything marked `sync: false` is prompted for on first deploy and then lives
in Render's store. No secret is in the file.

Two things in it are worth understanding rather than copying:

- **`buildCommand: npm ci --include=dev && npm run build`** — both halves of
  that line are a deploy that failed. The dashboard default `npm install` never
  compiles TypeScript, so there was no `dist/`. And `--include=dev` is needed
  because Render applies the service's environment to the *build* too: with
  `NODE_ENV=production` set, npm skips devDependencies, TypeScript is not
  installed, and `tsc` falls through to whatever is global on the build image —
  a major version ahead, which rejects this project's `moduleResolution` with an
  error that names `tsconfig.json` and looks nothing like a missing dependency.
- **`TRUST_PROXY: 1`** — Render terminates TLS in front of the process, so
  `X-Forwarded-For` is the proxy's word and can be trusted. Without it every
  audit entry records the load balancer's address and the login rate limiter
  buckets the entire internet into one counter.

There is deliberately **no Persistent Disk**, because images go to Cloudinary.

Any host that runs a long-lived Node process works the same way. **Not** a serverless platform:
uploads are written to disk, and the process holds a MongoDB connection pool
that pays for itself only if it lives.

```bash
npm ci && npm run build && npm start
```

`npm start` runs `dist/server.js`. Health check: `GET /api/health` — it returns
status and uptime and nothing else, so it is safe to leave open.

The Node version is pinned by `engines` and `.nvmrc` to **20 or newer**. Pin it
rather than take the host's default: nothing here uses an API newer than 20, but
a host that quietly defaults to 18 is a failure you debug at deploy time instead
of reading in a file.

> **`NODE_ENV=production` must not reach the install.** npm reads it as "skip
> devDependencies", TypeScript is one, and the build then fails on a host where
> it worked locally. On Render you cannot simply unset it — a service's
> environment applies to its build as well — so the install says
> `--include=dev` explicitly. A prod-only install has been verified to boot,
> serve real data and shut down cleanly, so nothing dev-only leaks into
> *runtime*; it just cannot produce the `dist/` it runs.

The process handles SIGTERM: it stops accepting connections, closes the MongoDB
connection, and exits 0, with an 8-second backstop that exits anyway if
something holds the loop open. Platforms that send SIGTERM and then SIGKILL get
a clean stop and a log line saying so.

### Environment

The server **refuses to start** in production without the first two. That is
deliberate — see `src/config/env.ts`.

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | 32+ random characters. `openssl rand -base64 48` |
| `MONGODB_URI` | The Atlas connection string |
| `CLIENT_ORIGIN` | Your Vercel domain, comma-separated if several |
| `TRUST_PROXY` | `1` if anything terminates TLS in front of Node |
| `CLOUDINARY_CLOUD_NAME` | See *Images go to Cloudinary* below |
| `CLOUDINARY_API_KEY` | |
| `CLOUDINARY_API_SECRET` | |
| `PAYSTACK_SECRET_KEY` | `sk_live_…` |
| `PAYSTACK_CALLBACK_URL` | `https://yourdomain.com/orders/callback` |
| `CURRENCY` | Must be one your Paystack account is enabled for |

`CLIENT_ORIGIN` still matters even though the rewrites remove CORS from the
normal path: it is what protects the API from a browser on somebody else's
site calling it directly.

Set `TRUST_PROXY` **only** when there really is a proxy. With none, trusting
`X-Forwarded-For` lets any client claim any IP — which would poison the audit
trail and let one attacker walk straight around the login rate limiter.

### Images go to Cloudinary

Set all three and every upload — logos, screenshots, merch artwork, and the
generated lifestyle renders — goes to Cloudinary and comes back as an absolute
`https://res.cloudinary.com/…` URL:

| Variable | |
| --- | --- |
| `CLOUDINARY_CLOUD_NAME` | From the dashboard |
| `CLOUDINARY_API_KEY` | |
| `CLOUDINARY_API_SECRET` | |

**All three or none.** Two out of three is a typo, and a typo that silently
falls back to writing onto a disk that gets wiped on the next deploy is
something nobody notices until the logos have gone — so the server refuses to
start on a partial answer.

This means **Render needs no Persistent Disk**, which is the one paid add-on
this deployment would otherwise want. Uploads never touch the container
filesystem, so a deploy wiping it costs nothing.

With none of the three set, uploads are written to `UPLOAD_DIR` (default
`./uploads`) and served from `/uploads` by this process. That is how local
development runs — no account, no keys, no network.

> The two modes produce **different shapes of URL**: a relative `/uploads/x.png`
> on disk, an absolute one on Cloudinary. The database stores whatever it is
> given, so a dump taken from a development database will have image URLs that
> do not resolve in production. Don't copy one into the other.

The 68 files in this repo's local `uploads/` are development seed artwork. A
fresh production database references none of them, so there is nothing to
migrate.

#### Check the keys before trusting them

```bash
npm run check:cloudinary          # locally, from source
npm run check:cloudinary:prod     # from the Render shell, after the first deploy
```

A real round trip: it uploads a small generated PNG through the same code path
the app uses, **fetches the returned URL back over the public internet**,
confirms an image comes back, and deletes it. It touches no database and leaves
nothing behind.

Run it in both places. The local run tests your copy of the keys; the Render run
tests the environment's copy, and that is the one that will be serving people.
A credentials-only check would pass in several situations where uploading still
fails, which would make it worse than no check.

## 3. Database

MongoDB Atlas. Allow the API host's egress addresses, or the whole internet if
the host has no static IPs — the connection string is the credential either
way.

**Never run `npm run seed` against it.** It wipes the database and inserts 30
demo launches plus 7 accounts that all share the password `deck1234`, which is
published in the README.

Create the first admin instead, which is a command rather than a route on
purpose:

```bash
# On the production host, where devDependencies are not installed:
npm run create-admin:prod -- --email you@example.com --name "Your Name" --username you

# Locally, from source:
npm run create-admin -- --email you@example.com --name "Your Name" --username you
```

The two do the same thing. `create-admin` runs the TypeScript through `tsx`,
which is a devDependency and therefore absent in production — the `:prod`
variant runs the compiled `dist/scripts/create-admin.js` instead. Reaching for
the wrong one on the server gives you `tsx: not found` at the moment you are
trying to make yourself an admin.

### No shell on the host?

A shell on the server is convenient, not necessary. What the script actually
needs is a connection to the production database, and that can come from
anywhere the database will accept a connection from — including your laptop:

```bash
MONGODB_URI="<the production connection string>" \
  npm run create-admin -- --email you@example.com --name "Your Name" --username you
```

The inline variable wins: `dotenv.config()` does not overwrite values that are
already in the environment, so this reaches production without touching your
local `.env` or leaving the string in a file. Atlas has to allow the address
you are calling from — if its access list is still `0.0.0.0/0` for the API
host, it already does.

Last resort, no tooling at all: register through the site like any other
visitor, then open the `users` collection in Atlas and change that document's
`role` from `user` to `admin`. It is the same single field the script sets. It
writes no audit entry, which the script does, so prefer the command when you
have the choice.

## 4. Paystack

Switch the dashboard to live mode, take the live secret key, and set the
webhook to:

```
https://YOUR-API-HOST/api/payments/paystack/webhook
```

It must point at the API host directly, **not** at the Vercel domain. The
handler verifies Paystack's signature against the raw request body, and a proxy
hop is a chance for those bytes to change.

## 5. Social sign-in (optional)

Both providers are independent and both are optional: whatever has keys is
offered on the sign-in page, and what does not is simply absent. With neither
set, Deck works exactly as it did — email and password.

First set the API's own public address, because the callback URL is built from
it and cannot be inferred behind a proxy:

```
PUBLIC_API_URL=https://YOUR-API-HOST
```

**GitHub** — Settings → Developer settings → OAuth Apps → New OAuth App:

```
Authorization callback URL: https://YOUR-API-HOST/api/auth/oauth/github/callback
```

**Google** — console.cloud.google.com → APIs & Services → Credentials → Create
OAuth client ID → Web application:

```
Authorised redirect URI:    https://YOUR-API-HOST/api/auth/oauth/google/callback
```

Then set `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` and `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` on the API host. Each pair is all-or-nothing; a lone id
makes the server refuse to start rather than fail later at a redirect.

Three things that will bite:

- **The callback URL must point at the API host, not at the Vercel domain.**
  The exchange sends the client secret, so it happens server to server, and the
  provider compares the redirect URI character for character against what is
  registered. A trailing slash is a different URL.
- **`CLIENT_ORIGIN`'s first entry is where the browser is sent afterwards.**
  The same ordering rule the share kit depends on — if localhost is first, a
  production sign-in ends on a machine that is not on the internet.
- **A provider account with no verified email is refused**, with a message
  saying so. Linking on an unverified address is how somebody signs up at a
  provider using your email and inherits your launches.

An account created this way has no password. It can sign in with that provider
for as long as the provider exists; signing in with a password needs one set
first, which today means an admin or a password reset flow.

## Known trade-off: link previews

`src/middleware/unfurl.ts` rewrites Open Graph tags per launch, so a
shared link unfurls with the product's own name, tagline and image. It only
runs when the API process is also serving the frontend build — which in this
split it is not.

So **every shared link will unfurl as generic "Deck"**, including the share
cards the launch pages generate. On a launch board, where being shared is the
point, that is a real loss rather than a cosmetic one.

Recovering it means a Vercel serverless function at `/item/[slug]` that fetches
the launch, injects the tags into the built shell, and returns it — porting
what `unfurl.ts` already does. Roughly an hour's work. Not done yet.

## Pre-flight

- [ ] `JWT_SECRET` generated fresh, 32+ characters, not in any file that ships
- [ ] `NODE_ENV=production`
- [ ] `MONGODB_URI` points at Atlas, not localhost
- [ ] `CLIENT_ORIGIN` is the real Vercel domain — without it every call is blocked
- [ ] `VITE_API_BASE_URL` set in Vercel **before** the build, not after
- [ ] All three `CLOUDINARY_*` variables set (no Persistent Disk needed)
- [ ] `npm run check:cloudinary:prod` passes **on Render**, not just locally
- [ ] `TRUST_PROXY` set if and only if there is a proxy
- [ ] Paystack in live mode, webhook pointed at the API host
- [ ] `create-admin:prod` run; `seed` not run
- [ ] Both `REPLACE-WITH-YOUR-API-HOST` placeholders edited in `vercel.json`
- [ ] `GET /api/health` returns 200 through the Vercel domain
