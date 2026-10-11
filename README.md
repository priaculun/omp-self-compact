# omp-self-compact

Native **OMP** extension yang membiarkan agent mengelola context window sendiri. Port perilaku [priaculun/self-compact](https://github.com/priaculun/self-compact) (fork dari `disler/self-compact-pi-agent`) ke API extension OMP; bukan extension Pi.

> Catatan: repo referensi tidak menyertakan source code (direktori `extensions/` kosong) — implementasi ini ditulis ulang dari perilaku yang dideskripsikan README-nya, memakai event/tool/command API OMP asli.

## Yang dilakukan

| Fase | Trigger | Perilaku |
| --- | --- | --- |
| **notice** | usage ≥ soft (default 10%) | satu pesan transient dengan angka live; semua tool tersedia |
| **warning** | usage ≥ warning (default 15%) | anjuran "compact soon", di-refresh tiap turn; semua tool tersedia |
| **forced** | usage ≥ warning + buffer (default 25%, cap 90%) | semua tool diblokir kecuali `self_compact` dan `view_context` |
| **handoff** | agent memanggil `self_compact({ note_to_self })` | note disimpan, compaction OMP native jalan sekali, note diteruskan verbatim ke ringkasan |

- Status bar: `self-compact: [####======----------] 32.5% ~notice`.
- `view_context` → angka usage sebagai JSON.
- Note dan opsi bertahan di session entries (branch/resume/compaction aman).
- Setelah compaction sukses, note terakhir ditampilkan sebagai handoff.

Perbedaan dari versi Pi: tidak ada pemblokiran regex stall-guard, tidak ada `summary.ts` instruction-replacement (kompaksi memakai `internalGuidance` native OMP), dan prompt dibaca dari `prompts/` paket + override `<cwd>/.omp/self-compact/`.

## Instalasi

```bash
omp plugin install github:priaculun/omp-self-compact
```

Lokal sekali jalan:

```bash
omp --extension "$PWD"
```

Extension **aktif otomatis** setiap session dimuat (default `enabled: true`). Cek status:

```text
/self-compact-info
```

Matikan sementara bila perlu: `/self-compact-off`.

## Konfigurasi

Global: `~/.omp/agent/self-compact.json`
Project: `<repo>/.omp/self-compact.json` — project menang.

```json
{
  "enabled": true,
  "softAt": "10%",
  "warnAt": "15%",
  "buffer": "10%"
}
```

Nilai threshold: persen (`"15%"`), token (`270000`, `"100k"`, `"1.5m"`), atau fraksi (`0.15`). Forced = warning + buffer, cap 90%.

Prompt editable (override di `<cwd>/.omp/self-compact/` atau `~/.omp/agent/self-compact/`):

- `USER_PROMPT_SOFT_SELF_COMPACT.md`
- `USER_PROMPT_WARNING_SELF_COMPACT.md`
- `USER_PROMPT_COMPACTION_MESSAGE.md`

Placeholder: `{{used_tokens}}`, `{{used_percent}}`, `{{window_tokens}}`, `{{soft_percent}}`, `{{warning_percent}}`, `{{forced_percent}}`, `{{warning_tokens}}`, `{{note}}`.

## Commands & tools

- `self_compact({ note_to_self })` — tool agent: simpan note + compact.
- `view_context()` — angka usage sebagai JSON.
- `/self-compact-info` — dump setting/threshold/state tanpa model turn.
- `/self-compact-now` — paksa handoff segera (butuh note dulu).
- `/self-compact-on`, `/self-compact-off` — aktif/nonaktif per session.

## Syarat

- OMP `18.9.x`.
- Extension berjalan in-process; bukan sandbox keamanan.

## Verifikasi

```bash
bun test
```

Adaptasi perilaku dari [priaculun/self-compact](https://github.com/priaculun/self-compact), upstream [disler/self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent). Lisensi MIT dipertahankan.
