# Tenant proxy (Cloudflare Worker)

Proxies `*.getbookking.com` tenant traffic to Firebase Hosting (`test-app-96812.web.app`).

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
