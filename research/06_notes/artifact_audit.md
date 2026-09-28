# Audit Artefak untuk Bab IV

> Diperbarui 28 September 2026. Temuan di bawah diverifikasi ulang langsung terhadap `src/`.

## Fakta yang terverifikasi
- Build lokal berhasil dengan `npm run build` pada 9 Agustus 2026.
- Runtime `WebCurlServer` mendeklarasikan versi `1.4.2` di `src/index.ts:85`.
- `CHANGELOG.md` mencatat rilis terbaru `1.4.2` pada 17 Februari 2026.
- Inkonsistensi versi `package.json` yang pernah dicatat sudah terselesaikan: sekarang `1.4.2`, selaras dengan runtime.
- Public GitHub snapshot yang diperiksa berada pada commit `97c3e7d6351c663b0b805c4bc9167bd474a0d4cb`.
- Source lokal `src/` kini berbeda dari snapshot public: ada modul tambahan `agent.ts`, `crawl.ts`, `extract.ts`, `fetch-html.ts`, `research.ts`, `search.ts`, dan `index.ts` sudah berubah.

## Tool surface v1.4.2
Tool yang diekspos melalui `list_tools` (10 tool, diverifikasi di `src/index.ts:368-546`):
`browser_configure`, `parse_document`, `fetch_api`, `download_file`, `multi_search`, `research`, `extract`, `crawl`, `agent`, `browser_close`.

Koreksi terhadap audit sebelumnya: `browser_flow` tidak pernah ada di source saat ini dan tidak lagi diekspos. Dokumentasi yang menyebut `browser_flow` sudah dikoreksi. Lower-level browser tools (`browser_snapshot`, `browser_network_requests`, dan lainnya) masih punya handler di `CallToolRequestSchema` tetapi sengaja tidak diekspos untuk mengurangi tool chaining.

## Temuan implementasi penting
- Browser menggunakan Puppeteer dengan profil persisten pada `user_data/`.
- Maksimum tab = 10; ketika penuh, tab tertua ditutup sebelum tab baru ditambahkan.
- Browser auto-close setelah idle 15 menit.
- Snapshot mendukung mode tree dan HTML slice, diekspos lewat handler tersembunyi `browser_snapshot` (`src/index.ts:708`).
- `fetch_api` memakai native `fetch`, AbortController, redirect mode, response-time measurement, dan output limit.
- `download_file` memakai streaming `pipeline` dan membuat folder tujuan bila belum ada.
- `multi_search` menjalankan beberapa query Google Custom Search secara paralel.
- `parse_document` menangani PDF dan DOCX. Percabangan DOCX memakai `mammoth.extractRawText` (`src/index.ts:798`), dideteksi lewat content-type `wordprocessingml` atau ekstensi `.docx`.
- Tidak ada lagi resource blocking di source. Klaim lama bahwa `blockResources` dipaksa `false` sudah tidak relevan karena simbol tersebut tidak ada di `src/`.

## Hal yang belum boleh diklaim sebagai final
- `README_METRICS.md` dan `scripts/run_metrics.ts` masih memakai skenario lama yang memanggil `google_search` dan `fetch_webpage`, sementara tool surface v1.4.2 sudah mengekspos `multi_search` dan `extract`. Harness perlu diperbarui sebelum dipakai sebagai eksperimen utama tesis.
- Data `metrics/` yang sudah tersedia tetap berguna sebagai bukti awal/paper, tetapi tidak boleh diperlakukan sebagai dataset eksperimen thesis release v1.4.2 tanpa rerun menggunakan harness yang sesuai.
- Folder `user_data/` pernah memuat cookie/session browser. Folder ini tidak disalin ke workspace research dan tidak boleh dimasukkan ke artefak publik tesis. Folder tersebut sudah dihapus pada 28 September 2026 dan akan dibuat ulang otomatis oleh server saat dijalankan.

## Keputusan untuk Bab IV
Bab IV akan membedakan: (1) fakta implementasi yang terverifikasi dari source, (2) evolusi dari artefak artikel, dan (3) pekerjaan yang masih harus diselesaikan sebelum thesis release. Tidak ada fitur atau hasil pengujian yang akan diklaim bila source/evidence tidak mendukungnya.
