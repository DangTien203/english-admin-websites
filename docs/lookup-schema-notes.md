# WordyGo · Ghi chú khảo sát schema cho tính năng tra từ (P1)

Ngày khảo sát: 13/10/2026 · Nguồn sự thật: các tệp migration trong `database/migrations/` (theo `docs/lookup-spec.md` §0.2).
Mọi thông tin dưới đây lấy từ đọc code và migration. **Chưa đối chiếu với dữ liệu thật**, vì DB cục bộ từ chối mật khẩu trong `.env` (mục 6 có câu SQL để bạn tự chạy).

---

## 1. Chức năng tra từ hiện tại

| Thành phần | Vị trí |
|---|---|
| Route tra từ | `routes/api/ebooks.ts`, `POST /api/v1/ebooks/:id/lookup` (khoảng dòng 699), mount ở `app.ts` tại `/api/v1/ebooks`, yêu cầu JWT (`requireApiAuth`) |
| Route dịch cả đoạn (ngoài phạm vi) | cùng tệp, `POST /:id/translate-paragraph`, có `requireFeature('translation_daily')`, dùng `translateText` (bảng `translation_cache`) |
| Làm sạch từ | `normalizeWord()` trong `services/wordTranslationService.ts` |
| Dịch dự phòng | `translateWord()` cùng tệp; gọi song song `callGoogleTranslate()` và `callFreeDictionary()`; lỗi cả hai thì ném `TranslationFailedError` (route đổi thành 503 `TRANSLATION_UNAVAILABLE`) |
| Truy vấn mục từ đầy đủ | `FULL_ENTRY_SQL` trong `utils/entryQueries.ts` |
| Bảng liên quan | `word_lookups`, `user_reading_progress.words_looked_up`, `word_translation_cache` |

Luồng hiện tại: làm sạch từ → (nếu có `paragraph_id`) xác nhận đoạn thuộc ebook → tăng `words_looked_up` chạy ngầm → tra `dictionary_entries` theo `LOWER(headword)` hoặc `LOWER(lemma)` với `published = TRUE` → nếu không có và `TRANSLATION_FALLBACK_ENABLED === 'true'` thì gọi `translateWord` (cache `word_translation_cache` rồi Google + Free Dictionary) → ghi `word_lookups`.

Điểm cần lưu ý cho P2:
- Công tắc hiện tại so sánh chặt `process.env.TRANSLATION_FALLBACK_ENABLED !== 'true'`, nên **khi biến chưa đặt thì đường dịch đang TẮT**. Spec đặt mặc định là `true`. Khi P2 chuyển sang `config/lookup.ts`, môi trường nào chưa đặt biến sẽ đổi từ tắt sang bật. P1 chưa đổi gì.
- Có hai biến môi trường cũ ngoài danh sách của spec: `GOOGLE_TRANSLATE_TIMEOUT_MS` (mặc định 5000) và `FREE_DICTIONARY_API_TIMEOUT_MS` (mặc định 3000). P2 sẽ thay bằng `LOOKUP_UPSTREAM_TIMEOUT_MS`.
- Tra từ điển hiện chỉ khớp `headword` và `lemma`, chưa tra `word_forms`.

## 2. Hạ tầng của dự án

| Hạng mục | Thực tế |
|---|---|
| Runner migration | `database/migrate.ts`: mảng `migrations` gồm `{ key, name, file }`; mỗi tệp `export = async (client: PoolClient) => {...}` (**chỉ có `up`, không có `down`**); mỗi migration chạy trong một transaction; theo dõi ở bảng `schema_migrations`; extension `uuid-ossp` tạo ngoài transaction. Không đổi `key` sau khi đã triển khai |
| Quy ước đặt tên | `NN_ten_ngan.ts` (01 đến 33); `CREATE TABLE IF NOT EXISTS`, SQL thuần; khóa chính UUID `DEFAULT uuid_generate_v4()` |
| Cấu hình/env | Không có module trung tâm: đọc `process.env` trực tiếp, `dotenv` nạp ở `config/db.ts` và `app.ts`. P1 thêm `config/lookup.ts` (zod) |
| Logger | Không có thư viện. Dùng `console.log/warn/error`; có một middleware log request chỉ chạy ngoài production (`app.ts`) |
| Truy cập DB | `pg` Pool duy nhất ở `config/db.ts` (`export = pool`), SQL thô, không ORM |
| HTTP client | `fetch` có sẵn của Node + `AbortController`; không có axios |
| Test | Jest + ts-jest đã cấu hình (`jest.config.js`), nhưng **thư mục `tests/` không tồn tại** (bị gitignore và đã xóa ở commit "Remove test & scripts"). Hiện `npm test` báo lỗi vì thiếu `tests/setup.ts` |
| Lint | **Không có** ESLint/Prettier, không có script lint |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) |
| Node | Không có `engines` hoặc `.nvmrc`. Máy cục bộ Node 24.14. Triển khai bằng Railway/Nixpacks, phiên bản Node không được khai báo. `pg-boss` 12 cần Node >= 22.12 |
| Thư viện | `@anthropic-ai/sdk` 0.80.0 (có kiểu `output_config.format` kiểu `json_schema` ở API chính, không cần beta); `zod` 4.3.6; `pg-boss` 12.37.1 (thêm ở P1; gói ESM, `require()` chạy được trên Node >= 22.12; kiểu TypeScript phân giải bình thường với cấu hình hiện tại) |
| Git | `.gitignore` chứa `/docs`, `/scripts`, `/tests`: **tệp trong `docs/` hiện không được git theo dõi** |

## 3. Schema thật của các bảng từ điển

Ký hiệu: PK khóa chính, FK khóa ngoại. Tất cả bảng con dùng `entry_id` trỏ tới `dictionary_entries(id) ON DELETE CASCADE` trừ khi ghi khác.

### dictionary_entries (01 + ALTER trong 01)
`id` UUID PK · `headword` VARCHAR(255) NOT NULL · `lemma` VARCHAR(255) NOT NULL · `ipa_us`, `ipa_uk` VARCHAR(255) · `audio_us_url`, `audio_uk_url` VARCHAR(500) · `pos` VARCHAR(50)[] DEFAULT '{}' · `meaning_vi` TEXT **NOT NULL** · `meaning_en` TEXT · `example_en`, `example_vi` TEXT · `cefr_level` VARCHAR(2) CHECK (A1..C2) · `frequency_rank` INT · `source` VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (`stardict`,`wiktionary`,`manual`,`user`) · `admin_note` TEXT · `published` BOOLEAN DEFAULT TRUE · `created_by` UUID FK admin_accounts ON DELETE SET NULL · `created_at`, `updated_at` TIMESTAMPTZ · `etymology` TEXT · `register` VARCHAR(30) CHECK (`formal`,`informal`,`slang`,`literary`,`technical`,`dated`,`humorous`) · `is_countable` BOOLEAN · `is_transitive` BOOLEAN. **UNIQUE (headword, lemma)**. Trigger `trg_dictionary_entries_updated_at`.
Index có sẵn: `idx_dict_headword`, `idx_dict_lemma` (btree thường, **không** phải `lower()`), `idx_dict_source`, `idx_dict_published`, `idx_dict_cefr`, `idx_dict_frequency`, GIN full-text `idx_dict_entries_search`.

### entry_senses
`id` · `entry_id` · `pos` VARCHAR(30) NOT NULL · `sense_order` INT NOT NULL DEFAULT 0 · `definition_en`, `definition_vi` TEXT · `register` VARCHAR(30) (cùng CHECK 7 giá trị như trên) · `domain` VARCHAR(100) · `grammar_note`, `usage_note` TEXT · `region` VARCHAR(30) · `created_at`. **UNIQUE (entry_id, pos, sense_order)**.

### sense_examples
`id` · `sense_id` FK entry_senses CASCADE · `example_en` TEXT NOT NULL · `example_vi` TEXT · `sort_order` INT DEFAULT 0 · `source` VARCHAR(50).

### word_forms
`id` · `entry_id` · `form_type` VARCHAR(30) NOT NULL CHECK (`base`,`third_person_singular`,`past_simple`,`past_participle`,`present_participle`,`plural`,`possessive`,`comparative`,`superlative`) · `form_value` VARCHAR(255) NOT NULL · `ipa` VARCHAR(255) · `audio_url` VARCHAR(500) · `tags` VARCHAR(50)[] · `sort_order` INT. **UNIQUE (entry_id, form_type, form_value)**. Index: `idx_word_forms_entry`, `idx_word_forms_type (entry_id, form_type)`.

### Các bảng còn lại
| Bảng | Cột chính và ràng buộc |
|---|---|
| `entry_synonyms` | PK (entry_id, synonym_id); synonym_id FK dictionary_entries; CHECK entry_id <> synonym_id |
| `entry_antonyms` | PK (entry_id, antonym_id); tương tự |
| `sense_synonyms` | PK (sense_id, synonym_text); `synonym_text` VARCHAR(255); `synonym_entry_id` UUID NULL FK dictionary_entries ON DELETE SET NULL |
| `sense_antonyms` | như trên với `antonym_text`, `antonym_entry_id` |
| `tags` | `id`, `name` VARCHAR(100) **UNIQUE** NOT NULL, `created_at` |
| `entry_tags` | PK (entry_id, tag_id); tag_id FK tags CASCADE |
| `entry_edit_history` | `id`, `entry_id`, `admin_id` UUID NULL FK admin_accounts SET NULL, `field_name` VARCHAR(100) NOT NULL, `old_value`, `new_value` TEXT, `created_at` |
| `entry_idioms` | `idiom_text` VARCHAR(500) NOT NULL, `definition_en/vi`, `example_en/vi`, `register` VARCHAR(30) (không có CHECK) |
| `phrasal_verbs` | `phrasal_verb` VARCHAR(255) NOT NULL, `particle` VARCHAR(30) NOT NULL, `is_separable` BOOLEAN, `definition_en/vi`, `example_en/vi` |
| `collocations` | `sense_id` NULL FK entry_senses SET NULL, `collocation` VARCHAR(255) NOT NULL, `pattern` VARCHAR(50), `example_en/vi`, `frequency` INT |
| `word_families` | `id`, `family_root` VARCHAR(255) NOT NULL |
| `word_family_members` | PK (family_id, entry_id); `relation` NOT NULL CHECK (`root`,`noun_form`,`verb_form`,`adj_form`,`adv_form`,`other`) |
| `entry_answer_aliases` (29) | `entry_id`, `answer_text` NOT NULL, `normalized_answer` NOT NULL, `source` NOT NULL DEFAULT 'admin' CHECK (`admin`,`ai_accepted`,`import`,`user_suggested`), `status` NOT NULL DEFAULT 'active' CHECK (`active`,`pending`,`rejected`), `created_by` FK admin_accounts SET NULL. UNIQUE (entry_id, normalized_answer) WHERE status = 'active' |

### Bảng tra cứu
| Bảng | Cột |
|---|---|
| `word_lookups` (03 + 26) | `id`; `user_id` NOT NULL FK users CASCADE; `entry_id` UUID **NULL** (đã bỏ NOT NULL ở 26) FK dictionary_entries CASCADE; `source` VARCHAR(20) NOT NULL CHECK (`ebook`,`flashcard`,`manual_search`); `ebook_id` FK ebooks SET NULL; `created_at`; `word_text` VARCHAR(100); `lookup_result` VARCHAR(20) DEFAULT 'dictionary' CHECK (`dictionary`,`translation`,`not_found`); `paragraph_id` UUID (không FK) |
| `user_reading_progress` | `words_looked_up` INT DEFAULT 0; UNIQUE (user_id, ebook_id) |
| `word_translation_cache` (26) | **DEPRECATED**, `word` VARCHAR(100) UNIQUE, `word_original`, `translation_vi` TEXT NOT NULL, `phonetic`, `audio_url`, `pos`, `definitions_en`/`examples`/`providers` JSONB, `hit_count`, timestamps. Không xóa, để quay lui |

## 4. Chênh lệch giữa lookup-spec §3 và schema thật

| # | Spec nói | Thực tế | Hệ quả / việc cần làm |
|---|---|---|---|
| 1 | `word_forms (form, loại dạng, ipa, audio_url)` | Cột là `form_value` và `form_type`; `form_type` bị **CHECK chỉ 9 giá trị** | Index `lower(form)` được tạo trên `form_value`. Dạng Wiktionary ngoài 9 giá trị (ví dụ dạng bất quy tắc, `alternative`) **không ghi được** nếu không ánh xạ hoặc nới CHECK. P5/P7 phải quyết định |
| 2 | Haiku đặt `register` là `vulgar` hoặc `offensive` (§9.6) | CHECK của `dictionary_entries.register` và `entry_senses.register` chỉ cho 7 giá trị (không có `vulgar`/`offensive`) | Ghi sẽ lỗi 23514. Cần nới CHECK ở một migration sau, hoặc ánh xạ sang `informal`/`slang` và ghi vào `usage_note` |
| 3 | `entry_answer_aliases` ghi các nghĩa phụ (§10.7) | Cần thêm `normalized_answer` NOT NULL, `source` thuộc 4 giá trị cho phép, `status` | Dùng `source='import'` hoặc `'ai_accepted'`, `status='active'`; tính `normalized_answer` bằng `normalizeVietnameseAnswer` (`utils/answerNormalizer.ts`) |
| 4 | `entry_tags + tags`, chủ đề "30 tên" | `tags.name` UNIQUE, VARCHAR(100). Số bản ghi `tags` thực tế chưa kiểm tra | Cần đúng 30 tên trong bảng; P6 phải đọc từ DB hoặc `classify-topics.mjs` |
| 5 | `UNIQUE (headword, lemma)` | Đúng | Mục từ dạng biến không tạo mới được trùng cặp này; dùng `word_forms` |
| 6 | `sense_order` "theo quy ước sẵn có" | Mặc định cột là **0**; UNIQUE (entry_id, pos, sense_order) nên hai sense cùng `pos` phải khác `sense_order`. Mã đọc chỉ `ORDER BY sense_order` | Cần xem dữ liệu thật để biết điểm bắt đầu (mục 6) |
| 7 | `word_lookups (user_id, entry_id, source, ebook_id, ...)` | `entry_id` đã nullable; có thêm `word_text`, `lookup_result`, `paragraph_id`. `source` chỉ nhận `ebook`, `flashcard`, `manual_search` | Tra từ trong ebook dùng `source='ebook'` (đúng với mã hiện tại) |
| 8 | Chỉ mục `lower(headword)`, `lower(lemma)` "nếu chưa có" | Chưa có (chỉ có btree thường) | Đã thêm ở migration 33 |
| 9 | Tên bảng trong `CLAUDE.md` | `CLAUDE.md` ghi `senses` và `dictionary_entry_tags`; tên thật là `entry_senses` và `entry_tags` | Chỉ là tài liệu cũ, không ảnh hưởng mã |
| 10 | `CLAUDE.md` mô tả dịch từ bằng Claude | Thực tế là Google Translate v2 + Free Dictionary API | Tài liệu cũ |
| 11 | Hàm trigger | Tên hàm `update_updated_at()`, trigger đặt tên `trg_<bảng>_updated_at`, hiện chỉ gắn cho 4 bảng (users, admin_accounts, dictionary_entries, lessons) | `word_enrichment_jobs` đã gắn theo cùng cách |

## 5. Thay đổi của P1

- Migration `33_lookup_foundation`: bốn bảng mới (`ref_wiktionary_en`, `ref_word_frequency`, `word_enrichment_jobs`, `api_usage_counters`), các index tra cứu, trigger `trg_word_enrichment_jobs_updated_at`. Không sửa bảng cũ. Chạy lặp lại không lỗi.
- Phần `ref_*` nằm ở `database/refdata/schema.ts` (`createRefTables`); khi `REFDATA_DATABASE_URL` có giá trị thì migration 33 bỏ qua phần này. Cách chạy: `docs/lookup-refdata.md`.
- `config/lookup.ts`: đọc và kiểm tra toàn bộ biến ở spec §1 bằng zod, nạp khi khởi động từ `app.ts`.
- `word_translation_cache` đánh dấu deprecated trong `services/wordTranslationService.ts` và ở mục 3 trên. Chưa xóa gì, hành vi endpoint giữ nguyên.

## 6. Dữ liệu thật (đã đo ngày 13/10/2026 trên DB Neon của môi trường dev)

Mục (d) của prompt P1, trước đây chưa trả lời được vì DB chưa kết nối. Số liệu lấy bằng truy vấn chỉ đọc.

| Câu hỏi | Kết quả thật |
|---|---|
| `sense_order` bắt đầu từ 0 hay 1? | **Từ 0** (`MIN(sense_order) = 0`, 1567 sense) |
| `word_forms` đang có những `form_type` nào? | `plural` 452, `past_participle` 257, `past_simple` 257, `third_person_singular` 257, `present_participle` 257, `comparative` 41, `superlative` 41, `base` 1 (tổng 1563 dòng; chưa có `possessive`) |
| `word_lookups.source` / `lookup_result` thật | `ebook`+`translation` 6, `ebook`+`dictionary` 3, `manual_search`+`dictionary` 3. Chưa có dòng `not_found` hay `flashcard` |
| `audio_us_url` là URL tuyệt đối hay tương đối? | **Đường dẫn tương đối**, ví dụ `advertise_us.mp3`, `advertisement_us.mp3` (khác dự đoán ở bản đầu của tài liệu này). App phải tự ghép tiền tố; bản tạm trả URL tuyệt đối của Free Dictionary |
| Số mục từ | 840 (`dictionary_entries`) |
| Bảng `tags` | **17** tên (spec §8.1 nói "30 tên chủ đề"): P6 phải dùng danh sách thật hoặc bổ sung |
| Bảng mới của migration 33 | Đã tồn tại. `ref_wiktionary_en` 0 dòng, `ref_word_frequency` 0 dòng, `api_usage_counters` 0 dòng trước P3 |
| Từ dùng thử | `run` và `ubiquitous` **không có** trong từ điển; `address`, `bank`, `bat`, `close` có (`source = wiktionary`) |

Hệ quả cho các bước sau: `sense_order` khi ghi mục từ mới bắt đầu từ **0** (P6b: một số chạy cho cả mục từ, còn mục từ cũ đánh số theo từng loại từ: `noun 0, verb 0, noun 1, verb 1`); `word_forms.form_type` không có `possessive` trong dữ liệu nên không cần ưu tiên; `ref_*` còn trống nên bước F4b (dạng biến cục bộ) chưa có tác dụng cho tới khi P4 nạp dữ liệu.

## 7. Bổ sung của P6b (đo ngày 15/10/2026 trên DB dev)

| # | Phát hiện | Hệ quả |
|---|---|---|
| 1 | `dictionary_entries.meaning_vi` cho phép NULL trong DB thật (`information_schema.columns.is_nullable = 'YES'`), dù migration `01_auth_content.ts` ghi `NOT NULL` | Chênh lệch giữa migration và DB (có thể đã sửa tay ngoài migration). Mã P6b không dựa vào ràng buộc: luôn ghi `meaning_vi` khác rỗng, không thì hủy mục từ (`invalid_output`). Nếu muốn khôi phục ràng buộc, làm bằng một migration mới (chưa làm) |
| 2 | `entry_senses.sense_order` của mục từ cũ đánh số theo từng loại từ (`noun 0, verb 0, noun 1, verb 1`) | Mục từ tự tạo dùng một số chạy chung 0, 1, 2... theo thứ tự của Haiku; cả hai thỏa `UNIQUE (entry_id, pos, sense_order)` |
| 3 | Bảng không có khóa duy nhất: `sense_examples`, `entry_idioms`, `phrasal_verbs`, `collocations`, `word_families`, `entry_edit_history`. `entry_answer_aliases` chỉ có chỉ mục duy nhất MỘT PHẦN (`WHERE status = 'active'`) | Ghi bằng `INSERT ... WHERE NOT EXISTS`, không dùng `ON CONFLICT` |
| 4 | Độ dài cột cần cắt (không bao giờ gặp 22001): `headword`, `lemma` 255; `ipa_*` 255; `audio_*_url` 500; `pos[]` phần tử 50; `entry_senses.pos` 30, `register` 30, `domain` 100, `region` 30; `word_forms.form_value` 255; `synonym_text` / `antonym_text` 255; `idiom_text` 500; `phrasal_verb` 255, `particle` 30; `collocation` 255, `pattern` 50; `family_root` 255 | `COLUMN_LIMITS` trong `services/enrichment/assemble.ts`. Khóa ngoại tới `dictionary_entries` đều `ON DELETE CASCADE` (trừ `collocations.sense_id`, `sense_synonyms.synonym_entry_id`, `sense_antonyms.antonym_entry_id`, `word_enrichment_jobs.entry_id`: `SET NULL`) nên xóa một mục từ xóa gọn mọi bảng con |
| 5 | `word_forms.form_type`: bảng chia động từ của Wiktionary gán thẻ `past + singular + third-person` cho "ran" | Phải đọc thẻ theo loại từ của DÒNG (`wiktionaryFormType`), không dùng `inferFormType` của P3 cho các ô của bảng. Xem `docs/lookup-enrichment.md` mục 12 |
