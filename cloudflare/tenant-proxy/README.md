# Tenant proxy (Cloudflare Worker)

Proxies `*.getbookking.com` tenant traffic to Firebase Hosting (`test-app-96812.web.app`).

## Custom domains (Namecheap → automatic connect)

Product rule: merchants **buy or transfer** a domain into Bookking (Namecheap API). We connect it automatically. There is **no DIY DNS** connect for domains left at GoDaddy/Vercel/etc.

### Data model

- `tenants/{id}`: `customDomain`, `customDomainWww`, `customDomainStatus` (`none` | `transferring` | `active` | …), `customDomainSource` (`purchase` | `transfer`), `customDomainProvider` (`namecheap`)
- `domainMappings/{host}`: `{ host, tenantId, slug, status }` — public read; written by Cloud Functions only

### App

Settings → **Domain**: check availability, start transfer (with auth code), buy (when checkout is wired), remove. In-app transfer instructions included.

### Runtime resolve

1. Cloudflare worker calls `resolveTenantDomain?host=` (or SPA reads `domainMappings`) for non-platform hosts.
2. Active mappings rewrite like a subdomain: `bleustattoos.com/book` → `…web.app/{slug}/book`.

### Enable Namecheap

1. Create a Namecheap account (use **sandbox** first: `api.sandbox.namecheap.com`).
2. Enable API (needs 20 domains, **$50 balance**, or $50 spent in last 2 years on live).
3. Whitelist your Cloud Functions egress IP under Namecheap → Profile → Tools → API Access.
4. Set secret `NAMECHEAP_API_KEY` and params:
   - `NAMECHEAP_API_USER`
   - `NAMECHEAP_CLIENT_IP`
   - optional `NAMECHEAP_USERNAME`, `NAMECHEAP_API_HOST` (sandbox default), `NAMECHEAP_NAMESERVER_1/2` (Cloudflare NS)
5. Deploy functions + worker; add worker routes for customer hostnames once nameservers point at Cloudflare.

Until Namecheap is configured, Buy/Transfer stay disabled in the app; free `{slug}.getbookking.com` still works.

## Team invites — `join.getbookking.com`

Invite links use **`https://join.getbookking.com/join?t=…`** (see iOS `Constants.Hosting.bookingWebOrigin`).

1. **DNS (Cloudflare → same zone)**  
   - Add **`join`** as **CNAME** to `@` (or your apex), **Proxied** (orange cloud).  
   - Or CNAME to `getbookking.com` if your apex is already proxied.

2. **Deploy worker** (includes `join` in reserved subdomains so it is not treated as a tenant slug):

   ```bash
   cd cloudflare/tenant-proxy && npx wrangler deploy
   ```

3. **Firebase Authentication**  
   - Authorized domains: add **`join.getbookking.com`** so email/password sign-in on the join page works.

4. **Optional apex**  
   - Routes `getbookking.com/join*` and `www.getbookking.com/join*` are also deployed if apex is orange-cloud through Cloudflare.
