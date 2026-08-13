# Harbor Charters (Boating / Fishing) demo assets

Source: Desktop `Get Bookking Pics/Boating:Fishing` (Pexels).

| File | Use |
|------|-----|
| `01-hero.jpg` | Site hero |
| `02-gallery.jpg` … `06-gallery.jpg` | Gallery / featured strip |

Upload example:

```bash
node scripts/upload-tenant-hero.js --slug=YOUR_SLUG --file=scripts/assets/harbor-charters/01-hero.jpg
node scripts/upload-tenant-gallery.js --slug=YOUR_SLUG \
  --files=scripts/assets/harbor-charters/02-gallery.jpg,scripts/assets/harbor-charters/03-gallery.jpg,scripts/assets/harbor-charters/04-gallery.jpg,scripts/assets/harbor-charters/05-gallery.jpg,scripts/assets/harbor-charters/06-gallery.jpg
```

Industry raw value: `charters` · Classic theme id: `charter-v1`
