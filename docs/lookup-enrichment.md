# WordyGo · Làm giàu từ điển: thu thập nguồn, Claude Haiku, kiểm tra, gộp và ghi database (P6a + P6b)

Cập nhật: 15/10/2026 · Đặc tả gốc: `docs/lookup-spec.md` §8, §8.1, §9, §10, §11, §12 · Hàng đợi và worker: `docs/lookup-queue.md` · Dữ liệu `ref_*`: `docs/lookup-refdata.md`.
Mẫu đã chạy thật và đánh giá: `docs/lookup-enrichment-samples.md` (P6a), mục 17 dưới đây (P6b).

**Phạm vi:** đường ống đầy đủ S0 đến S7. Một job đi từ một từ tra cứu đến mục từ hoàn chỉnh trong `dictionary_entries` và các bảng con, trong MỘT transaction, idempotent, theo chính sách xuất bản `ENRICHMENT_PUBLISH_POLICY`.
- **P6a (mục 1 đến 9):** S1 đến S4, thu thập nguồn, gọi Haiku, kiểm tra đầu ra. `generateDraft(bundle)` trong `services/enrichment/draft.ts`; xem bản nháp bằng `npm run enrich:draft -- --word <w>` (không ghi DB).
- **P6b (mục 10 đến 16):** S0, S2, S5 đến S7. `runEnrichment(job)` trong `services/enrichment/pipeline.ts` thay chỗ gắn rỗng của P5; chạy tay bằng `npm run enrich:run -- --word <w> [--dry-run]`, duyệt bằng `npm run enrich:review`.

---

## 1. Quy ước dữ liệu thật

Đo ngày 14/10/2026 trên DB dev (Neon) bằng SQL chỉ đọc. DB này là DB dev duy nhất, chưa có người dùng thật. Mục nào khác `docs/lookup-spec.md` thì theo mục này (spec §0.2).

### 1.1 Mục từ hiện có (`dictionary_entries`: 840 dòng, tất cả `source='wiktionary'`, `published=true`)

| Hạng mục | Thực tế | Hệ quả cho bước ghi (P6b) |
|---|---|---|
| `pos` (`dictionary_entries.pos[]`) | `noun` 543, `verb` 262, `adjective` 159, `adverb` 68, `preposition` 23, `conjunction` 8, `pronoun` 7, `determiner` 4, `exclamation` 3, `modal verb` 2, `number` 1, `article` 1 | 12 giá trị này là enum `pos` của schema Haiku. Cột không có CHECK |
| `entry_senses.pos` | cùng 12 giá trị (`noun` 802, `verb` 380, `adjective` 235, `adverb` 77, `preposition` 41, `conjunction` 10, `pronoun` 7, `determiner` 6, `exclamation` 3, `modal verb` 3, `article` 2, `number` 1) | `sense_order` bắt đầu từ **0** |
| Mã `pos` của Wiktionary | `adj`, `adv`, `intj`, `prep`, `conj`, `pron`, `det`, `name`, `phrase`, `prefix`, `suffix`, `contraction`, ... | Cần bảng ánh xạ ở P6b (adj → adjective, adv → adverb, intj → exclamation, prep → preposition, conj → conjunction, pron → pronoun, det → determiner). `name` là tên riêng, không lập mục. `phrase`, `prefix`... không có trong 12 giá trị: Haiku chọn loại gần nhất hoặc bỏ |
| `register` | `dictionary_entries`: null 780, `formal` 55, `informal` 4, `literary` 1. `entry_senses`: null 1450, `formal` 91, `informal` 21, `technical` 3, `literary` 2 | **CHECK** (cả hai bảng): `formal, informal, slang, literary, technical, dated, humorous`. Từ thô tục / miệt thị: `register` null và cảnh báo trong `usage_note`. `entry_idioms.register` là `VARCHAR(30)` không có CHECK |
| `domain` | `entry_senses.domain VARCHAR(100)`, không CHECK; 1394 null; giá trị là từ tiếng Anh viết thường: `computing` 24, `politics` 16, `law` 14, `business` 13, `medical` 10, `finance` 10, `legal` 9, `entertainment` 7, `art` 6, `biology` 5, `education` 5, `military` 5, `chemistry` 4, `media` 4, `science` 4, `mathematics` 4, ... | Prompt yêu cầu: một từ tiếng Anh viết thường, hoặc null |
| `region` | `VARCHAR(30)`, không CHECK, **cả 1567 sense đều null** | Prompt: US, UK, Australia... hoặc null |
| `word_forms.form_type` | CHECK 9 giá trị (`base, third_person_singular, past_simple, past_participle, present_participle, plural, possessive, comparative, superlative`); đang dùng `plural` 452, `past_participle` 257, `past_simple` 257, `third_person_singular` 257, `present_participle` 257, `comparative` 41, `superlative` 41, `base` 1 | Dạng không ánh xạ được thì không ghi (đã ghi ở lookup-schema-notes §4) |
| Chữ hoa chữ thường | `lemma` luôn **chữ thường** (0 dòng ngoại lệ). `headword` khác `lower(headword)` chỉ ở **4 dòng**: `AIDS` (lemma `aids`), `April` (`april`), `August` (`august`), `CD` (`cd`) | Quy tắc thành schema: `lemma` chữ thường, một từ; `headword` là dạng hiển thị và **chỉ được khác `lemma` ở chữ hoa chữ thường** (validator kiểm tra) |
| IPA | cả 840 dòng có `ipa_us` và `ipa_uk`; **838 dòng bọc trong dấu gạch chéo** `/.../`, không dòng nào dùng ngoặc vuông. 2 dòng có chú thích: `abuse` = `/əˈbjuːs/ (n), /əˈbjuːz/ (v)`, `close` = `/kloʊz/ (verb) /kloʊs/ (adj)`. Dữ liệu Wiktionary: IPA cũng có dấu gạch chéo trong `sounds[].ipa` (81.769 dòng có ít nhất một giá trị kiểu `/.../`), nhưng 7.835 dòng có giá trị kiểu `[...]` (phiên âm hẹp) | P6b: giữ dấu gạch chéo; bỏ giá trị trong ngoặc vuông |
| Audio | **40 dòng** có `audio_us_url` / `audio_uk_url`, tất cả là **tên tệp tương đối** (`advertise_us.mp3`), 0 URL tuyệt đối | Xem 1.2 |
| Bảng `tags` | **47** dòng = 17 tag cũ (`Academic, Advanced, Beginner, Business, Communication, Daily, Education, Emotions, Finance, Food & Home, IELTS, Intermediate, Law & Politics, Science, TOEIC, Technology, Travel`) + **đủ 30** tên của `TOPIC_NAMES` (đã nạp bằng `docs/seed-topics.sql`). `entry_tags` hiện **trống** | Chỉ 30 tên chủ đề được dùng; 17 tag cũ bị bỏ qua và không bao giờ bị sửa hay xóa |

### 1.2 Audio: app có phát được URL tuyệt đối của Wikimedia không?

**Kết luận (đã cập nhật ở P6b): app phát được URL tuyệt đối; nó KHÔNG ghép tiền tố cho tên tệp.** Mã Flutter (`wordygo/lib`) truyền giá trị của `audio_*_url` nguyên văn vào `just_audio`: `word_lookup_popup.dart` (`_audio.setUrl(url)`), `dictionary/widgets/audio_button.dart` (`_player.setUrl(url)`), `ebook/providers/*` (`AudioSource.uri(Uri.parse(...))`). Không có chỗ nào nối tiền tố. Vì vậy P6b ghi URL tuyệt đối (`mp3_url` của Wikimedia). Chưa thử phát một URL `upload.wikimedia.org` trên máy thật: nếu thiết bị chặn, đổi `pickWiktionaryAudio` (một hàm) để trả NULL, endpoint TTS sẽ tạo bản R2 khi cần.

Kết luận gốc của P6a (giữ để tham khảo): không xác minh được từ repo back-end, nhưng có bằng chứng gián tiếp là có.

- **Back-end không biến tên tệp thành URL ở bất kỳ chỗ nào.** Mọi chỗ đọc `audio_us_url` / `audio_uk_url` (`routes/api/home.ts`, `routes/api/leitner.ts`, `routes/api/practice.ts`, `routes/api/retrieval.ts`, `services/leitnerSessionService.ts`, `routes/api/dictionary.ts`) trả giá trị **nguyên văn** cho app. `views/dictionary/show.ejs` cũng đặt nguyên giá trị vào `data-url`.
- `POST /api/v1/dictionary/entries/:id/tts` lưu **URL tuyệt đối** (`R2_PUBLIC_URL/...mp3`) vào đúng hai cột này. Vậy các cột đã chứa lẫn lộn: 40 tên tệp tương đối (từ lần nhập Oxford) và, khi có người bấm phát âm, URL tuyệt đối của R2. App đã phải xử lý URL tuyệt đối `https://` cho trường hợp thứ hai.
- Mã app Flutter không nằm trong repo, nên **không thể xác nhận** nó phát được URL của `upload.wikimedia.org` (cùng là `https://...mp3`, nhưng chưa biết có danh sách tên miền cho phép, tiêu đề yêu cầu... hay không). Dữ liệu Wiktionary có `mp3_url` tuyệt đối (74.332 dòng), đã mã hóa phần trăm (`%28eng%29`).
- 40 tên tệp tương đối hiện có nhiều khả năng đang hỏng (không có tiền tố), nằm ngoài phạm vi P6.

**Đề xuất cho P6b:** ghi `mp3_url` của Wikimedia nếu bạn xác nhận app phát được (thử một URL thật trên máy); nếu không, để `audio_*_url` là NULL để endpoint TTS tạo bản R2 khi cần.

### 1.3 Cột của các bảng con (cho hình dạng phần tử trong schema Haiku)

| Bảng | Cột (kiểu, ràng buộc) | Phần tử trong schema |
|---|---|---|
| `entry_idioms` (381 dòng) | `idiom_text VARCHAR(500) NOT NULL`, `definition_en`, `definition_vi`, `example_en`, `example_vi` (TEXT), `register VARCHAR(30)` không CHECK | `{ idiom_text, definition_en, definition_vi, example_en, example_vi }` (không gửi `register`) |
| `phrasal_verbs` (117) | `phrasal_verb VARCHAR(255) NOT NULL`, `particle VARCHAR(30) NOT NULL`, `is_separable BOOLEAN DEFAULT false`, `definition_en/vi`, `example_en/vi` | `{ phrasal_verb, particle, is_separable, definition_en, definition_vi, example_en, example_vi }` |
| `collocations` (1703) | `sense_id UUID NULL` (FK `entry_senses` ON DELETE SET NULL), `collocation VARCHAR(255) NOT NULL`, `pattern VARCHAR(50)`, `example_en/vi`, `frequency INT` | `{ collocation, pattern, example_en, example_vi }`; `sense_id` và `frequency` không đoán |
| `entry_answer_aliases` (1) | `answer_text NOT NULL`, `normalized_answer NOT NULL`, `source` CHECK (`admin, ai_accepted, import, user_suggested`), `status` CHECK (`active, pending, rejected`), `created_by`; **UNIQUE một phần** (`entry_id, normalized_answer`) WHERE `status='active'` | không có trong schema Haiku: P6b tự suy ra từ `meanings_vi` (spec §10.7), `source='ai_accepted'` hoặc `'import'` |
| `word_families` (0) / `word_family_members` | `family_root VARCHAR(255)`; thành viên: `family_id, entry_id, relation` CHECK (`root, noun_form, verb_form, adj_form, adv_form, other`) | **không có trong schema Haiku** (prompt P6a không đưa `word_families` vào danh sách khóa); P6b có thể dựng từ `derived` / `related` của Wiktionary |
| `sense_examples` | `example_en NOT NULL`, `example_vi`, `sort_order`, `source` | `examples[]` của mỗi sense |
| `entry_edit_history` | `field_name NOT NULL`, `old_value`, `new_value`, `admin_id` NULL | P6b ghi `auto_created` |

Không có chênh lệch nào khác với `docs/lookup-schema-notes.md`.

---

## 2. Sơ đồ S1 đến S4

```
 word (đã chuẩn hóa, chữ thường)
   │
   ├─ S1  collectSources()   services/enrichment/sources/
   │       ┌──────────── song song, Promise.allSettled, mỗi nguồn có timeout, được phép thiếu ─────────────┐
   │       │ ref_wiktionary_en (word)   ref_word_frequency (zipf, rank)   Datamuse (ứng viên đồng/trái nghĩa) │
   │       └──────────────────────────────────────────────────────────────────────────────────────────────────┘
   │         + dòng của lemma (chỉ khi onlyFormRows)
   │         + Free Dictionary: CHỈ khi Wiktionary không có dòng nào
   │              404 JSON → not_found (bình thường) · lỗi tạm → ném UpstreamUnavailable (pg-boss thử lại)
   │       → SourceBundle { word, expectedLemma, wiktionaryRows, lemmaRows, freeDictionary, frequency, datamuse, flags }
   │
   ├─ (S2 của P6b: quyết định từ cờ)   haikuSkipReason(): unknown_word, variant_form → KHÔNG gọi Haiku
   │
   ├─ S3  generateDraft(bundle)  draft.ts + haiku/
   │       system prompt TĨNH (quy tắc + 30 chủ đề + enum, prompt caching)
   │       + tin nhắn người dùng: MỘT khối <data> JSON gọn (summarizeForPrompt, Free Dictionary, tần suất, ứng viên)
   │       → output_config.format = json_schema → JSON
   │
   └─ S4  kiểm tra: JSON.parse → zod → validateDraft (luật + làm sạch)
           đạt  → { ok: true, draft, usage, repaired }
           sai  → gửi lại cuộc hội thoại + danh sách lỗi (đúng 1 lần) → đạt: repaired=true
                                                                       → sai: { ok: false, reason: 'invalid_output', details }
           refusal → invalid_output ngay, không sửa
```

---

## 3. Schema đầu ra cuối cùng (`services/enrichment/haiku/schema.ts`)

Hai bản mô tả cùng một hình dạng: **zod** (`DraftSchema`) và **JSON Schema** (`DRAFT_JSON_SCHEMA`, gửi trong `output_config.format`). JSON Schema viết tay, chỉ dùng từ khóa API hỗ trợ (spec §9.2): không đệ quy, không `minimum` / `maximum` / `minLength` / `maxLength`, `minItems` chỉ 0 hoặc 1, `additionalProperties: false`, mọi thuộc tính đều `required`, `enum` chỉ gồm chuỗi hoặc null. `tests/enrichment/schema.test.ts` kiểm tra hai bản khớp khóa ở mọi cấp, và không có từ khóa bị cấm. Số tham số kiểu hợp (`['string','null']` hoặc `enum` có null) là 9, dưới giới hạn 16; API biên dịch được schema (không báo "too complex").

| Khóa | Kiểu | Ghi chú |
|---|---|---|
| `is_english_word` | bool | false: không phải từ tiếng Anh |
| `is_proper_noun` | bool | chỉ tên riêng (người, địa danh, tổ chức, thương hiệu, tên tác phẩm) |
| `variant_of` | string \| null | dạng chuẩn khi là lỗi chính tả / dạng lỗi thời / phi chuẩn |
| `headword` | string | dạng hiển thị; khác `lemma` chỉ ở chữ hoa chữ thường |
| `lemma` | string | chữ thường, một từ |
| `pos` | enum[] | 12 giá trị (mục 1.1); validator **suy lại** từ `senses` theo thứ tự xuất hiện |
| `cefr_level` | A1..C2 \| null | null cho từ không lập mục |
| `is_countable`, `is_transitive` | bool \| null | validator đặt null nếu không có nghĩa danh từ / động từ |
| `topics` | string[] | tối đa 3 trong 30 tên (zod nhận chuỗi; **validator** bỏ tên lạ) |
| `senses` | object[] | tối đa 6 (zod) |
| `senses[].pos` | enum | |
| `senses[].definition_en` | string | tối đa 25 từ (validator) |
| `senses[].meanings_vi` | string[] | **1 đến 4** (zod; schema JSON `minItems: 1`); mục tiêu 2 đến 4 nằm ở system prompt |
| `senses[].register` | 7 giá trị CHECK \| null | |
| `senses[].domain`, `region`, `grammar_note`, `usage_note` | string \| null | `domain` thường viết thường, cắt 100 ký tự; `region` cắt 30 |
| `senses[].examples` | `{ example_en, example_vi }[]` | 1 đến 2 |
| `senses[].synonyms`, `antonyms` | string[] | chữ thường, tối đa 8 (validator cắt) |
| `idioms` | `{ idiom_text, definition_en, definition_vi, example_en, example_vi }[]` | tối đa 5, được rỗng |
| `phrasal_verbs` | `{ phrasal_verb, particle, is_separable, definition_en, definition_vi, example_en, example_vi }[]` | tối đa 5, được rỗng |
| `collocations` | `{ collocation, pattern, example_en, example_vi }[]` | tối đa 5, được rỗng |
| `notes_for_review` | string[] | điểm không chắc; validator thêm các dòng `[kiểm tra] ...` |

**Khác prompt gốc P6a:** (1) `cefr_level` nhận null và `topics`, `senses`, `pos` được rỗng, để từ bị loại (không phải từ, tên riêng, lỗi chính tả) trả về bản tối giản rẻ; với từ thật validator vẫn đòi `cefr_level`, ít nhất một sense và mỗi sense ít nhất một ví dụ. (2) `topics` trong zod là chuỗi chứ không phải enum, để validator có thể **bỏ** tên lạ như spec §9.7 yêu cầu (JSON Schema đã ép enum phía API). (3) Không có `word_families`.

---

## 4. Lời gọi Haiku (`haiku/client.ts`)

Model, `max_tokens` và timeout lấy từ `AnthropicEnrichClient` (`ANTHROPIC_MODEL_ENRICH`, `ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH`, `ANTHROPIC_TIMEOUT_MS_ENRICH`); **không có tên model trong mã** (test kiểm tra system prompt không chứa tên model).

| Tham số | Giá trị | Vì sao |
|---|---|---|
| `output_config.format` | `{ type: 'json_schema', schema: DRAFT_JSON_SCHEMA }` | đầu ra có cấu trúc, GA, không cần beta header |
| `thinking` | `{ type: 'disabled' }` | Haiku 5.5 **bật suy luận thích ứng theo mặc định**, và token suy luận tính vào `max_tokens`. Với `max_tokens` mặc định 4000, một mục từ 6 sense dễ bị cắt. Tắt suy luận để cả ngân sách dành cho JSON và chi phí dự đoán được. `disabled` hợp lệ khi `effort` từ `high` trở xuống |
| `output_config.effort` | `low` | cặp với `thinking: disabled` |
| `temperature`, `top_p`, `top_k` | **không gửi** | **Đã thử một lần (14/10/2026):** `temperature: 0.2` → HTTP 400 "`temperature` is deprecated for this model" (request `req_011Cg2EQStz9kHgcn37PsRDu`). Mô hình chỉ nhận giá trị mặc định. Client chỉ gửi nếu truyền `temperature` rõ ràng (để thử lại sau khi model đổi) |
| `system` | một khối `text` có `cache_control: { type: 'ephemeral' }` | prompt caching; phần tĩnh |
| dự phòng | nếu model từ chối `output_config` (lỗi 400 nhắc `output_config` / `json_schema`), gọi lại **một lần** với tool bắt buộc `submit_entry` có cùng schema | spec §9.2; chưa từng xảy ra ngoài test. **Đã vá ở P6b:** trước đó lỗi 400 này làm mở circuit breaker nên lần gọi dự phòng bị chặn (`breaker_open`) và dự phòng không bao giờ chạy. Giờ lỗi 400 mang `output_config` được đánh dấu `affectsBreaker=false` (`UpstreamConfigError`), breaker bỏ qua nó; mọi lỗi 400 / 401 / 403 khác vẫn mở breaker. Có test với breaker THẬT (`tests/enrichment/p6aFixes.test.ts`) |

**Kích thước thực đo:** system prompt khoảng 10,3K ký tự tiếng Việt; API tính **khoảng 7,7K đến 7,9K token** cho khối được cache (gồm cả JSON Schema, và tiếng Việt chia token dày hơn ước lượng ký tự / 4 nhiều). Tin nhắn người dùng 140 đến 1500 token. Token ra 170 đến 1840 mỗi từ. Chi phí: xem `docs/lookup-enrichment-samples.md` (trung bình khoảng $0.0008 cho mục từ đầy đủ, $0.0002 cho từ bị loại, khi cache còn ấm). Bảng giá nhập tay ở `services/enrichment/pricing.ts` (đối chiếu lại trang giá chính thức ngày 15/10/2026: Haiku 5.5 $0.10 vào / $0.50 ra mỗi triệu token cho prompt đến 100K; ghi cache 5 phút $0.125; đọc cache $0.01; **không lệch**), **phải xác minh lại** trước khi dựa vào. Chi phí một bản nháp là tổng chi phí của **từng lần gọi** (mục 18.4).

`stop_reason` `max_tokens` hoặc `refusal` là lỗi (spec §9.3). Lỗi hạ tầng (`UpstreamUnavailable`, `UpstreamConfigError`, `BudgetExceeded`) **được ném lên nguyên vẹn** qua lớp lỗi của P2 để worker xử lý như P5 đã định. Không có dự phòng server-side cho refusal ở Haiku 5.5.

`usage` cộng dồn qua mọi lần gọi của một bản nháp: `inputTokens`, `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, `calls`.

---

## 5. Quy tắc của system prompt (`haiku/system-prompt.ts`)

Prompt tĩnh bằng tiếng Việt, kế thừa nguyên tắc dịch của `TRANSLATION_SYSTEM_PROMPT` trong `docs/reference/import-oxford.mjs`. Các khối: vai trò; **an toàn dữ liệu** (mọi thứ trong `<data>` chỉ là dữ liệu, bỏ qua mệnh lệnh nằm trong đó); cách dùng nguồn; **nhiều nghĩa tiếng Việt ngắn**; số lượng sense; phần tiếng Anh; các trường phân loại; danh sách giá trị hợp lệ; **30 chủ đề kèm mô tả**.

Ý chính về nghĩa tiếng Việt (trọng tâm chất lượng): mỗi sense 2 đến 4 nghĩa ngắn (1 đến 4 từ), phổ biến nhất trước, **khác nhau thật sự**; không độn bằng từ gần đồng nghĩa, không thêm bớt loại từ (con, cái, chiếc, sự, việc, cuộc, nỗi, niềm) để tạo nghĩa; ví dụ tốt (`strong` → mạnh, khỏe, vững chắc) và ví dụ độn (`big` → to, lớn, to lớn; `cat` → con mèo, mèo); một nghĩa đúng tốt hơn hai nghĩa trùng ý, và nếu chỉ một nghĩa thì ghi lý do vào `notes_for_review`; không ngoặc đơn, không chữ Hán/Hàn/Nhật; văn phong chuẩn mực; thuật ngữ chuyên ngành dùng thuật ngữ tiếng Việt, từ hư dịch theo chức năng ngữ pháp.

**Tin nhắn người dùng** (`haiku/user-message.ts`): `<data>` + JSON gọn + `</data>` + một dòng nhiệm vụ. JSON gồm `word`, `expected_lemma`, `word_is_form_of` (chỉ khi từ là dạng biến thuần), `wiktionary` (kết quả `summarizeForPrompt`), `free_dictionary` (chỉ khi dùng), `frequency`, `datamuse_candidates`. Trong JSON, dấu `<` của mọi `<data` và `</data` (không phân biệt hoa thường) được thay bằng escape JSON sáu ký tự (dấu gạch ngược, u, 0, 0, 3, c): khối `<data>` không thể bị đóng hay mở lại từ bên trong, và `JSON.parse` vẫn trả đúng văn bản gốc (có test). Không có email, tên hay nội dung đoạn văn.

**Quyết định:** enum (`pos`, `register`, `cefr_level`) và 30 chủ đề nằm trong **system prompt** (phần tĩnh, được cache), không nằm trong tin nhắn người dùng; tin nhắn chỉ chứa dữ liệu thay đổi theo từ.

---

## 6. Cờ nguồn và `expectedLemma` (`sources/wiktionary.ts`)

Dựa trên dữ liệu thật (`docs/lookup-refdata.md` §5). `ref_wiktionary_en.word` là chữ thường còn `data.word` giữ chữ hoa (`London`, `RAN`, `Ran`); dòng "chính" của từ là dòng có `data.word` trùng chữ thường hoàn toàn.

| Cờ | Điều kiện |
|---|---|
| `onlyFormRows` | có dòng chính là **dạng biến** (có `lemma_of` là một từ đơn, khác chính từ, `pos` khác `name`, không phải viết tắt, không phải dòng lỗi chính tả) và các dòng chính còn lại không phải dạng biến chứa **tối đa 1 sense** (hằng `STRAY_SENSE_LIMIT`) |
| `onlyVariantRows` | mọi dòng chính chỉ có sense mang tag `misspelling`, `obsolete`, `archaic`, `nonstandard`, `dialectal`, `rare` hoặc `proscribed` (danh sách ở `services/lookup/wiktionaryTags.ts`) |
| `onlyProperNounRows` | mọi dòng của từ (mọi kiểu chữ) có `pos = name` |
| `noSourceRecognizesWord` | không có dòng Wiktionary, Free Dictionary trả 404 JSON, không có trong `ref_word_frequency`, **và không nguồn nào bị lỗi** (lỗi nguồn nghĩa là chưa kết luận được) |

`expectedLemma`: lemma Wiktionary nêu khi `onlyFormRows` (đã kiểm tra lemma có dòng không phải tên riêng); chính từ đó khi có dòng chính độc lập; null cho còn lại (lỗi chính tả, tên riêng, không rõ). `formLemmas` liệt kê mọi lemma mà dòng dạng biến trỏ tới (từ như `saw` có `see` nhưng không phải dạng biến thuần). Khi `onlyFormRows`, bản nháp là về **lemma**, nên `wiktionary` trong prompt là các dòng của lemma kèm `word_is_form_of`.

**Dòng "lạc" (stray) của `ran`**: dòng danh từ `ran` (nghĩa "sợi dây cuộn trên tời") là một sense độc lập duy nhất; nếu tính nghiêm thì `ran` không bao giờ là dạng biến thuần. Các từ như `went`, `men`, `led` cũng có dạng này. Quy tắc dung sai "tối đa 1 sense độc lập" cho `ran` → `onlyFormRows=true`, `expectedLemma=run`; `strayRows` ghi lại số dòng đã được bỏ qua để P6b quyết định. `saw` (3 sense độc lập), `left`, `bit`... vẫn là từ thật.

`expectedLemma` của `ran` **không bao giờ** là `royal australian navy` hay `radio access network` (hai dòng `RAN` có `lemma_of` là cụm từ và `data.word = RAN`): có test trên dữ liệu thật.

---

## 7. Validator (`haiku/validators.ts`) và bảng lỗi

`validateDraft(draft, { word, expectedLemma })` trả `{ issues, draft }`: `issues` có đường dẫn trường (`senses[1].meanings_vi[2]`) và dẫn tới thử lại; `draft` là bản đã **làm sạch** (cắt khoảng trắng, bỏ dấu chấm cuối nghĩa, viết thường đồng/trái nghĩa...). Mỗi luật có test đúng và sai (`tests/enrichment/validators.test.ts`).

| Luật | Mã | Hành động |
|---|---|---|
| JSON không parse được | `json` | lỗi → thử lại |
| Sai schema (khóa lạ, sai enum, quá 6 sense, quá 4 nghĩa, thiếu ví dụ...) | `schema_*` | lỗi → thử lại |
| `refusal` | `refusal` | `invalid_output` ngay |
| `max_tokens` | `max_tokens` | thử lại, yêu cầu gọn hơn |
| nghĩa rỗng / quá 40 ký tự / quá 6 âm tiết | `empty`, `too_long`, `too_many_syllables` | lỗi |
| nghĩa có ngoặc đơn (cả toàn chiều rộng) | `parenthesis` | lỗi |
| chữ Hán, Hàn, Nhật (kể cả trong ví dụ, ghi chú) | `cjk` | lỗi |
| hai nghĩa trùng nhau sau khi chuẩn hóa hoa/thường và khoảng trắng | `duplicate` | lỗi |
| hai nghĩa chỉ khác loại từ / hạn định từ đứng đầu (con mèo / mèo; một tập podcast / tập podcast) | `classifier_duplicate` | lỗi |
| mọi nghĩa của sense đều giống hệt từ tiếng Anh | `same_as_english` | lỗi (từ vay mượn như karaoke được một nghĩa trùng nếu có nghĩa khác) |
| `definition_en` rỗng hoặc quá 25 từ | `empty`, `too_long` | lỗi |
| `example_vi` rỗng, giống `example_en`, hoặc có chữ Hán/Hàn/Nhật | `empty`, `same_as_english`, `cjk` | lỗi |
| `lemma` không phải một từ chữ thường; `headword` khác `lemma` ngoài chữ hoa/thường | `format`, `headword_lemma` | lỗi |
| `lemma` khác `expectedLemma` (không phân biệt hoa thường) | `lemma_mismatch` | lỗi |
| từ thật thiếu `cefr_level` hoặc không có sense | `missing`, `empty` | lỗi |
| tên chủ đề lạ | (ghi chú) | **bỏ**, ghi notes; hết thì để **rỗng**, không thay bằng `academic_formal` |
| `academic_formal` cùng chủ đề khác, hoặc trình độ dưới C1 | (ghi chú) | bỏ (chỉ giữ khi là chủ đề duy nhất và C1/C2) |
| thành ngữ / cụm động từ / cụm kết hợp hỏng (rỗng, quá dài, ký tự lạ, cụm động từ không bắt đầu bằng động từ) | (ghi chú) | **bỏ** mục đó, không thử lại; quá 5 mục thì cắt |
| đồng/trái nghĩa trùng, quá 8, hoặc là chính từ đang xét | (ghi chú) | làm sạch |
| `definition_en` dùng lại chính từ | (ghi chú) | không từ chối, chỉ ghi `[kiểm tra]` |
| từ không lập mục (không phải tiếng Anh, tên riêng, `variant_of` khác null) mà bản nháp vẫn có senses, pos, topics, cụm từ, cefr_level, is_countable, is_transitive | (ghi chú) | **bỏ hết** nội dung đó, không kiểm tra, không thử lại; ghi `[kiểm tra] bỏ nội dung của từ không lập mục` (P6b; trước đó nội dung lọt qua không kiểm tra) |
| `lemma` chứa ký tự regex (`c++`, `foo(`) | `format` | là một lỗi `lemma` như thường; `escapeRegExp` bảo đảm validator không ném `SyntaxError` (P6b) |
| quá 10 ghi chú của Haiku | (ghi chú) | cắt còn 10 ghi chú của Haiku; các dòng `[kiểm tra]` của validator luôn được giữ đủ (P6b; trước đó chúng bị cắt trước) |

**Thử lại đúng một lần**, bằng cuộc hội thoại: tin nhắn gốc, bản trả lời trước (assistant), tin nhắn mới liệt kê lỗi kèm đường dẫn và yêu cầu trả **toàn bộ** JSON đã sửa. Vẫn sai: `{ ok: false, reason: 'invalid_output', details }` (details là lỗi của lần cuối). Không có lần thứ ba.

### Bảng lỗi cấp hệ thống

| Tình huống | Kết quả |
|---|---|
| Free Dictionary lỗi tạm (không phải 404) khi Wiktionary không có dòng | `UpstreamUnavailable` → worker đặt hàng `queued`, pg-boss thử lại |
| Free Dictionary 404 JSON | `not_found` (bình thường) |
| Wiktionary / tần suất / Datamuse lỗi hoặc quá hạn | nguồn đó coi như thiếu, ghi vào `sourceErrors`; không làm hỏng job; `noSourceRecognizesWord` không được đặt true |
| Thiếu bất kỳ tên nào trong 30 chủ đề ở bảng `tags` | `EnrichmentConfigError` mã `topics_not_seeded` (liệt kê tên thiếu). **Khi khởi động (P6b):** `startEnrichmentRuntime` ném lỗi TRƯỚC khi mở pg-boss và đăng ký worker (log `topics_not_seeded`, tiến trình `npm run worker` thoát mã 1; API vẫn phục vụ), nên job nằm yên trong hàng đợi. Trước đó worker vẫn khởi động rồi làm mọi job `failed / config_error` vĩnh viễn. Ở đầu mỗi job vẫn kiểm tra: `failed / config_error`, không thử lại. Lỗi cơ sở dữ liệu khi kiểm tra KHÔNG bị báo là `topics_not_seeded` |
| 400 / 401 / 403 từ Anthropic | `UpstreamConfigError` → `failed / config_error` |
| Hết ngân sách Anthropic | `BudgetExceeded` → `skipped / budget` |
| 429, 5xx, hết thời gian | `UpstreamUnavailable` → thử lại theo pg-boss |
| Đầu ra sai sau một lần sửa, hoặc refusal | trả `invalid_output` (P6b ghi `failed / invalid_output`) |

---

## 8. Lệnh và tệp

```bash
# (P6b) đường ống đầy đủ S0 đến S7 cho một từ, không qua hàng đợi; xem mục 10 đến 16
npm run enrich:run -- --word serendipity --dry-run   # S0 đến S5: gọi Haiku, in mục từ và bảng sẽ ghi, KHÔNG ghi DB
npm run enrich:run -- --word serendipity             # ghi DB (từ chối chạy khi ENRICHMENT_PUBLISH_POLICY=auto, trừ khi có --allow-auto)
npm run enrich:review -- [--limit 20] [--unpublished] [--word serendipity]   # duyệt các mục từ tự tạo (admin_note bắt đầu bằng "[auto]")

# S1 đến S4 cho một từ, KHÔNG ghi DB (không bỏ qua từ đã có trong từ điển, dùng được cho "run")
npm run enrich:draft -- --word ubiquitous            # báo cáo dễ đọc
npm run enrich:draft -- --word recieve --force       # vẫn gọi Haiku dù không đáng (xem Haiku tự phân loại)
npm run enrich:draft -- --word run --json            # một tài liệu JSON
```

Mặc định lệnh **không gọi Haiku** khi `noSourceRecognizesWord` (`unknown_word`) hoặc `onlyVariantRows` (`variant_form`), giống job thật (spec §8, S2). Lỗi tạm của Free Dictionary được chấp nhận (chỉ ở lệnh này) và ghi vào báo cáo.

| Tệp | Vai trò |
|---|---|
| `services/enrichment/topics.ts` | 30 tên và mô tả (sinh từ `classify-topics.mjs`), `loadTopicIds` |
| `services/enrichment/sources/{wiktionary,frequency,index}.ts` | S1, cờ, `summarizeForPrompt` |
| `services/enrichment/haiku/{schema,system-prompt,user-message,client,validators}.ts` | S3, S4 |
| `services/enrichment/draft.ts` | `generateDraft` |
| `services/enrichment/index.ts` | nối dây với client thật |
| `services/enrichment/pricing.ts` | bảng giá nhập tay |
| `services/enrichment/errors.ts` | `EnrichmentConfigError` |
| `services/lookup/refDb.ts` | `getRefDb()` dùng chung (tách khỏi `services/lookup/index.ts`) |
| `scripts/enrichment/draft.ts` | lệnh `enrich:draft` |
| `services/enrichment/pos.ts` | (P6b) `normalizePos`: mã loại từ của nguồn → 12 giá trị của DB |
| `services/enrichment/assemble.ts` | (P6b) S5, `assembleEntry`, `buildMeaningVi`, cắt chuỗi theo cột |
| `services/enrichment/persist.ts` | (P6b) S6, `persistEntry`, `linkFormOnly`, `findExistingEntry` |
| `services/enrichment/pipeline.ts` | (P6b) `runPipeline`, `createPipeline`, `runEnrichment` (S0 đến S7) |
| `services/enrichment/wiring.ts` | (P6b) nối pipeline với DB, client và breaker thật |
| `services/enrichment/usage.ts` | (P6b) token → `api_usage_counters` sau mỗi lần gọi Haiku |
| `scripts/enrichment/run.ts`, `review.ts` | (P6b) lệnh `enrich:run`, `enrich:review` |

Test (không gọi mạng): `tests/enrichment/*` (schema, prompt, summarize, validators, draft/client, sources, topics) và `sourceFlags.realdata.test.ts` (chỉ đọc `ref_*` thật, không gọi Haiku).

---

## 9. Quyết định đã tự đưa ra và giới hạn đã biết

1. **Tắt suy luận** (`thinking: disabled`, `effort: low`): tránh cắt cụt ở `max_tokens=4000`. Đổi sang suy luận thích ứng có thể cải thiện chất lượng nghĩa nhưng cần nâng `ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH`.
2. **Dung sai "1 sense lạc"** cho `onlyFormRows` (mục 6): cần thiết để `ran` ra `true`; có thể gây nhầm với từ có đúng một nghĩa độc lập quan trọng.
3. **`academic_formal` chỉ khi đơn độc và C1/C2**: Haiku hay gán kèm chủ đề khác; kết quả sau khi bỏ chưa luôn tốt (xem mẫu).
4. **`summarizeForPrompt` chỉ gửi 6 sense** (theo yêu cầu): từ nhiều nghĩa như `run` (22 sense), `light` (43), `bank` (42) bị thiếu nghĩa quan trọng. Xem đánh giá ở `docs/lookup-enrichment-samples.md`.
5. Luật chống độn chỉ bắt được dạng **cơ học**; độn về nghĩa (hai cách nói của cùng một ý) cần người duyệt.
6. Free Dictionary treo (timeout / 522) với từ không tồn tại: từ rác sẽ đi vào `failed / upstream_error` chứ không phải `rejected / unknown_word` nếu không xử lý ở S2.
7. `word_families` chưa được đưa vào schema.
8. System prompt thực tế khoảng 7,9K token (không phải 2,5K): đổi bất kỳ ký tự nào là vô hiệu hóa cache (ghi cache khoảng $0.001 một lần mỗi 5 phút không hoạt động).


---

# Phần 2 (P6b): từ job đến mục từ hoàn chỉnh

## 10. Sơ đồ S0 đến S7

```
 job { word (đã chuẩn hóa), jobRowId, signal }
   │
   ├─ (đầu job) loadTopicIds(): thiếu 30 chủ đề → EnrichmentConfigError (xem mục 15)
   │
   ├─ S0  findExistingEntry([word])   headword | lemma | word_forms.form_value, lower(), published hay không
   │        có ─────────────────────────────────────────────────► skipped / exists   (không dịch vụ ngoài, không khóa)
   │
   ├─ S1  collectSources(word)        Wiktionary + tần suất + Datamuse song song; Free Dictionary CHỈ khi không có dòng Wiktionary
   │        Free Dictionary lỗi tạm (không phải 404) ───────────► ném UpstreamUnavailable → pg-boss thử lại
   │
   ├─ S2  quyết định lemma
   │        mọi dòng là lỗi chính tả / lỗi thời ────────────────► skipped / variant_form      (KHÔNG gọi Haiku)
   │        không nguồn nào nhận ra từ ─────────────────────────► rejected / unknown_word     (KHÔNG gọi Haiku)
   │        chỉ là dạng biến của lemma L:
   │            entry của L đã có ──► linkFormOnly ─────────────► succeeded / form_linked     (KHÔNG gọi Haiku)
   │            entry của L chưa có ─► S1 lần nữa cho L (dòng, tần suất, Datamuse CỦA L), làm giàu L,
   │                                   thêm dạng biến vào word_forms trong cùng transaction
   │        còn lại ────────────────► làm giàu chính từ
   │
   ├─ S3/S4  generateDraft(bundle)    1 lần gọi + tối đa 1 lần sửa
   │        sai sau lần sửa ────────────────────────────────────► failed / invalid_output     (không thử lại)
   │        is_proper_noun ─────────────────────────────────────► rejected / proper_noun
   │        !is_english_word ───────────────────────────────────► rejected / not_english
   │        variant_of khác null ───────────────────────────────► skipped / variant_form
   │        lemma của bản nháp khác từ đang làm giàu ───────────► skipped / lemma_mismatch    (không tạo mục từ)
   │
   ├─ S5  assembleEntry(bundle, draft, ctx)   thuần, không DB
   │        meaning_vi rỗng ────────────────────────────────────► failed / invalid_output
   │
   ├─ S6  persistEntry   MỘT transaction, khóa advisory theo lemma, kiểm tra lại sự tồn tại
   │        entry đã có (job khác vừa ghi) + có dạng biến ──────► succeeded / form_linked
   │        entry đã có, không có gì để nối ────────────────────► skipped / exists
   │        tạo mới ────────────────────────────────────────────► succeeded
   │
   └─ S7  trả EnrichmentOutcome { status, reason, entryId, model, inputTokens, outputTokens, stagesMs } cho worker.
          Worker ghi word_enrichment_jobs và dòng log `enrich` (có stages_ms). Token đã được cộng vào api_usage_counters
          NGAY SAU MỖI LẦN GỌI Haiku (services/enrichment/usage.ts), nên không mất khi một giai đoạn sau lỗi.
```

**Lỗi thì ném, kết quả nghiệp vụ thì trả** (hợp đồng với `services/queue/enrichmentWorker.ts`): `UpstreamUnavailable` và lỗi lạ → pg-boss thử lại; `UpstreamConfigError` / `EnrichmentConfigError` → `failed / config_error`; `BudgetExceeded` → `skipped / budget`. Breaker `anthropic` mở ngay khi `BudgetExceeded` (`spend_limit`, `provider_quota`) hoặc lỗi cấu hình 400 / 401 / 403 (trừ 400 về `output_config`), nên các job sau nhận `breaker_open` (`UpstreamUnavailable`, thử lại sau) thay vì gọi vô ích.

**Một job cho dạng biến.** Khi `ran` chỉ là dạng biến của `run` và `run` chưa có, pipeline thu thập nguồn LẦN HAI cho `run` (dòng Wiktionary, tần suất, ứng viên Datamuse của `run`), nhờ Haiku viết mục từ `run`, và thêm `ran` (`past_simple`) vào `word_forms` trong cùng transaction. Bản nháp luôn nói về lemma, không bao giờ về dạng biến. Chỉ đi một bước (dạng biến của dạng biến → `skipped / lemma_mismatch`).

**Từ có nghĩa riêng thì không phải dạng biến thuần.** `running` có cả nghĩa danh từ, tính từ, trạng từ của riêng nó (`onlyFormRows = false`), nên job `running` làm giàu chính `running`. Khi `run` đã có thì `running` nằm trong `word_forms` của `run` (Wiktionary liệt kê `running` trong `forms` của `run`) và S0 dừng ở `exists`. Tương tự `ran` và `runs`: sau khi `run` được tạo, cả ba đều dừng ở S0 và không tốn token. Nhánh `form_linked` chỉ chạy khi dạng biến CHƯA nằm trong `word_forms` (ví dụ `appreciations` của `appreciation`, mục từ cũ).

## 11. Bảng mã `reason` cuối cùng

| Mã | `status` | Ai đặt | Ý nghĩa |
|---|---|---|---|
| (không có) | `succeeded` | pipeline | Đã tạo mục từ mới; `entry_id` trỏ tới nó |
| `form_linked` | `succeeded` | pipeline | Chỉ thêm dạng biến vào `word_forms` của entry đã có (hoặc vừa được job khác tạo); không gọi Haiku khi entry đã có từ trước |
| `exists` | `skipped` | pipeline (S0, S2, S6) | Đã có entry khớp headword / lemma / `word_forms`, published hay chưa; hoặc không có gì để nối (loại dạng biến không xác định) |
| `variant_form` | `skipped` | pipeline (S2, S4) | Mọi dòng Wiktionary là lỗi chính tả / lỗi thời / phi chuẩn, hoặc Haiku đặt `variant_of` |
| `lemma_mismatch` | `skipped` | pipeline (S2, S4) | Lemma của bản nháp khác từ tra, hoặc dạng biến của một dạng biến; không tạo mục từ, admin xử lý |
| `budget` | `skipped` | worker | `BudgetExceeded` (hết ngân sách Anthropic) |
| `daily_cap` | (không có hàng) | enqueuer | Hết `ENRICHMENT_MAX_JOBS_PER_DAY` |
| `duplicate` | `skipped` | enqueuer | `send` trả `null` |
| `unknown_word` | `rejected` | pipeline (S2) | Không nguồn nào nhận ra từ |
| `proper_noun` | `rejected` | pipeline (S4) | Haiku: tên riêng |
| `not_english` | `rejected` | pipeline (S4) | Haiku: không phải từ tiếng Anh |
| `invalid_output` | `failed` | pipeline (S4, S5) | Bản nháp sai sau một lần sửa, hoặc không thể tạo `meaning_vi`; không thử lại |
| `config_error` | `failed` | worker | `UpstreamConfigError` / `EnrichmentConfigError` (`topics_not_seeded`) |
| `upstream_error` | `queued` → `failed` | worker | `UpstreamUnavailable` hoặc lỗi lạ; lần cuối thì `failed` |
| `dead_letter`, `stale`, `queue_error`, `invalid_word` | | worker / reconcile / enqueuer | Xem `docs/lookup-queue.md` §9 |
| `pipeline_not_ready` | | | Của chỗ gắn rỗng P5. **Không còn được tạo** từ P6b; có thể còn trong hàng sổ cũ |

## 12. Quy tắc gộp (S5, `services/enrichment/assemble.ts`)

`assembleEntry` thuần (không DB, không mạng, không đồng hồ). Nguồn theo trường (spec §8.1, sửa theo dữ liệu thật):

| Trường | Nguồn và quy tắc |
|---|---|
| `lemma` | Bản nháp (đã kiểm tra: chữ thường, một từ, bằng `expectedLemma` nếu nguồn nêu) |
| `headword` | Dạng chữ của Wiktionary: chữ thường nếu có dòng không phải tên riêng viết thường; nếu không thì `data.word` (`April`, `AIDS`); không có Wiktionary thì của Haiku. Chỉ khác `lemma` ở chữ hoa chữ thường |
| `pos[]` | Loại từ của các sense đã ghi, theo thứ tự xuất hiện, bỏ trùng, đúng 12 giá trị của DB (`normalizePos` đổi mã Wiktionary / Free Dictionary: `adj` → `adjective`, `intj` → `exclamation`...; `name`, `phrase`, `prefix`... → bỏ). Khác loại từ của Wiktionary thì ghi vào `admin_note` |
| `ipa_us`, `ipa_uk` | Wiktionary `sounds` có thẻ giọng: Mỹ = `US`, `General-American`; Anh = `UK`, `Received-Pronunciation`, `Southern-England`. Giữ dấu gạch chéo `/…/` (như 838 / 840 dòng hiện có); bỏ giá trị trong ngoặc vuông và IPA cụt (`/-ˌkæst/`). Rồi Free Dictionary (`us`, `uk`; nếu cả hai thiếu thì IPA không rõ giọng vào `ipa_us`, ghi vào `admin_note`). **Cuối cùng** (chỉ khi `ipa_us` vẫn trống): IPA hợp lệ ĐẦU TIÊN của Wiktionary **không có thẻ nào** làm `ipa_us`, và `admin_note` có thêm `[ipa-untagged]` để lọc được; **không bao giờ** điền `ipa_uk` từ IPA không thẻ. Rồi NULL. **Không bao giờ lấy IPA từ Haiku.** Chi tiết và số đo: mục 18.2 |
| `audio_us_url`, `audio_uk_url` | `mp3_url` (rồi `ogg_url`) của Wiktionary; giọng theo thẻ, nếu không có thì theo tên tệp (`en-us-*`, `En-uk-*`); tệp Lingua Libre lấy giọng của thẻ vùng. **URL tuyệt đối**, giữ nguyên hoặc bỏ (dài hơn 500 ký tự thì bỏ, không cắt). Rồi Free Dictionary. Rồi NULL |
| `meaning_vi` | Vòng tròn (spec §9.8): nghĩa thứ nhất của từng sense theo thứ tự sense, rồi nghĩa thứ hai... bỏ nghĩa trùng (chuẩn hóa bằng `normalizeVietnameseAnswer`); dừng khi đủ 6 nghĩa hoặc khi thêm một nghĩa nữa vượt 200 ký tự; nối bằng `'; '`. Rỗng thì lấy nghĩa đầu của sense đầu; vẫn rỗng thì `failed / invalid_output` (không bao giờ ghi chuỗi rỗng) |
| `meaning_en`, `example_en`, `example_vi` | Của sense đầu (ví dụ đầu); sense đầu không có ví dụ thì ví dụ đầu tiên tìm được |
| sense | `pos`, `definition_en`, `register` (chỉ 7 giá trị của CHECK, khác thì NULL), `domain`, `region`, `grammar_note`, `usage_note`, ví dụ: **của Haiku** (Haiku đã thấy thẻ Wiktionary; danh sách sense của nó đã viết lại và đổi thứ tự nên không ghép 1-1 với Wiktionary được). `definition_vi` = tối đa 4 nghĩa nối bằng `'; '`. `sense_order` bắt đầu từ 0, một số chạy cho cả mục từ (xem mục 16) |
| `cefr_level` | Haiku; luôn ghi là ước tính trong `admin_note` |
| `frequency_rank` | `ref_word_frequency.rank` của LEMMA; thiếu thì NULL |
| `is_countable`, `is_transitive` | Wiktionary trước (`head_templates`: `countable` / `uncountable`; thẻ sense: `transitive`, `intransitive`, `ambitransitive`), rồi Haiku; chỉ khi mục từ có nghĩa danh từ / động từ |
| `etymology` | `etymology_text` của dòng Wiktionary không phải tên riêng, bỏ phần "Etymology tree" (cây tổ tiên, mỗi dòng 2 đến 4 từ) rồi lấy từ dòng văn xuôi đầu tiên; cây không có văn xuôi (bị loader cắt ở 1000 ký tự) thì NULL; tối đa 1000 ký tự |
| `register` (mục từ) | `register` của sense đầu |
| `word_forms` | `forms` của Wiktionary, theo loại từ của DÒNG (bảng chia động từ liệt kê cả "ran" với thẻ quá khứ + ngôi 3 số ít: ô của bảng không phải dạng riêng). Bỏ dạng không ánh xạ được vào 9 `form_type`, mang thẻ misspelling / obsolete / archaic / nonstandard / dialectal / rare / proscribed, nhiều từ, bằng headword / lemma; tối đa 20 |
| `sense_synonyms`, `sense_antonyms` | Danh sách của sense Wiktionary khớp nhất (cùng loại từ, trùng nội dung định nghĩa tiếng Anh ≥ 0,25 theo hệ số Dice; không khớp thì không mượn), **đã lọc**: chỉ từ đơn không có dấu nháy, có trong `ref_word_frequency`, xếp theo tần suất giảm dần, tối đa 5 mỗi loại (mục 18.3); ĐỨNG TRƯỚC, rồi lựa chọn của Haiku (không lọc); chữ thường, bỏ trùng, khác headword và lemma, tổng tối đa 8. Datamuse chỉ là ứng viên Haiku đã thấy, không ghi trực tiếp. `synonym_entry_id` trỏ tới entry ĐÃ CÓ và published (khớp lemma), không thì NULL |
| `entry_synonyms`, `entry_antonyms` | Chỉ nối tới entry ĐÃ CÓ và published (khớp `lemma`); không tạo entry mới để nối |
| `entry_tags` | Haiku, 30 tên chủ đề, tối đa 3 (id lấy từ bộ nhớ `loadTopicIds`) |
| `entry_answer_aliases` | Các nghĩa của mọi sense còn lại sau khi trừ những nghĩa đã nằm trong `meaning_vi`; `normalized_answer` = `normalizeVietnameseAnswer`; `source = 'ai_accepted'`, `status = 'active'`. Chỉ mục duy nhất là chỉ mục MỘT PHẦN nên dùng `INSERT ... WHERE NOT EXISTS` |
| `entry_idioms`, `phrasal_verbs`, `collocations` | Chỉ các mục Haiku đã qua kiểm tra, tối đa 5 mỗi loại (`collocations.sense_id` và `frequency` để NULL) |
| `word_families` | Chỉ khi `derived` / `related` của Wiktionary có từ đơn đã là entry published: tạo (hoặc dùng lại) họ `family_root = lemma`, thành viên `root` (mục từ mới) và tối đa 5 entry có sẵn (`noun_form`, `verb_form`, `adj_form`, `adv_form`, `other` theo loại từ đầu của entry đó) |
| `source`, `created_by` | `'wiktionary'`, NULL |
| `entry_edit_history` | Một dòng `auto_created`, `admin_id` NULL, `new_value` = `{"job_id", "sources", "model"}` |

**Phân tầng và `published`** (spec §3, §10.3). Tầng A (thiếu thì `published = false`): headword, lemma, pos (từ 1), `meaning_vi`, từ 1 sense có `definition_en` và `definition_vi`, từ 1 ví dụ có cả hai thứ tiếng. Tầng B (thiếu vẫn xuất bản, ghi vào `admin_note`): IPA (một trong hai), `cefr_level`, `frequency_rank`, `is_countable` (khi có nghĩa danh từ), `is_transitive` (khi có nghĩa động từ), từ 1 chủ đề, `etymology`. `ENRICHMENT_PUBLISH_POLICY=review` → luôn `false`; `auto` → `true` khi đủ tầng A.

**`admin_note`** bắt đầu bằng `[auto]`, rồi (ngăn cách bằng ` · `): nguồn đã dùng, model, id job, trạng thái xuất bản, tầng A thiếu, tầng B thiếu, trường là ước tính (`cefr_level=B1`), cảnh báo giọng IPA, loại từ Wiktionary không có trong mục, ghi chú của Haiku (kể cả dòng `[kiểm tra]` của validator). Không chứa email, tên hay nội dung của người dùng. Tối đa 4000 ký tự.

**Cắt chuỗi theo cột** (không bao giờ gặp 22001; `COLUMN_LIMITS` trong `assemble.ts`, đo từ `information_schema` ngày 15/10/2026): headword 255, lemma 255, ipa 255, audio 500, phần tử `pos` 50, `cefr_level` 2, `entry_senses.pos` 30, `register` 30, `domain` 100, `region` 30, `form_value` 255, `synonym_text` 255, `idiom_text` 500, `phrasal_verb` 255, `particle` 30, `collocation` 255, `pattern` 50, `family_root` 255. URL không bị cắt: dài quá thì bỏ.

## 13. Ghi database (S6, `services/enrichment/persist.ts`)

1. `BEGIN`, rồi `pg_advisory_xact_lock(hashtextextended('enrich:' || lemma, 0))`: các job cùng lemma (`ran`, `running`, `run`) xếp hàng ở đây. Khóa chỉ lấy lúc ghi, không giữ trong lúc chờ Wiktionary / Free Dictionary / Haiku.
2. Kiểm tra lại sự tồn tại (headword, lemma, `word_forms.form_value`, `lower()`). Đã có: nếu job xuất phát từ một dạng biến thì thêm dạng biến, trả `form_linked`; không thì trả `exists`. Không sửa gì của entry đã có.
3. Thứ tự ghi (spec §10.4): `dictionary_entries` → `entry_senses` → `sense_examples` → `word_forms` → `sense_synonyms` → `sense_antonyms` → `entry_synonyms` → `entry_antonyms` → `entry_tags` → `entry_answer_aliases` → `entry_idioms` → `phrasal_verbs` → `collocations` → `word_families` / `word_family_members` → `entry_edit_history`. Mỗi bảng MỘT câu lệnh (`unnest` các mảng), khoảng 15 lượt gọi cho cả transaction.
4. `ON CONFLICT DO NOTHING` ở mọi bảng có khóa (`dictionary_entries (headword, lemma)`, `entry_senses (entry_id, pos, sense_order)`, `word_forms (entry_id, form_type, form_value)`, `sense_synonyms`, `sense_antonyms`, `entry_synonyms`, `entry_antonyms`, `entry_tags`, `word_family_members`); `INSERT ... WHERE NOT EXISTS` ở bảng không có khóa (`sense_examples`, `entry_idioms`, `phrasal_verbs`, `collocations`, và `entry_answer_aliases` vì chỉ mục duy nhất chỉ áp khi `status='active'`). Không xóa rồi ghi lại.
5. Lỗi giữa chừng: `ROLLBACK` toàn bộ (có test ép lỗi ở từng bảng con). Lỗi `23505` (một tiến trình khác vừa ghi) và `ON CONFLICT (headword, lemma)` không trả dòng được xử lý như "đã tồn tại".
6. `linkFormOnly(entryId, form, type)`: thêm một dòng `word_forms` vào entry đã có, cũng dưới khóa advisory. Không thêm khi đã có dòng cùng `form_value` (không phân biệt hoa thường, bất kể `form_type`). Loại dạng biến không xác định thì không ghi (CHECK chỉ cho 9 giá trị).

## 14. Công cụ dòng lệnh

```bash
npm run enrich:run -- --word <w> [--dry-run] [--allow-auto]
```
In từng giai đoạn kèm thời gian, token, chi phí ước tính (bảng giá nhập tay, phải xác minh lại; tính từng lần gọi Haiku rồi cộng, mục 18.4) và kết quả. `--dry-run`: S0 đến S5 (CÓ gọi Haiku), in mục từ đã gộp và bảng sẽ ghi (bảng, số dòng), KHÔNG ghi. Không dùng hàng đợi, không tạo hàng `word_enrichment_jobs`; mã job trong `admin_note` có dạng `cli-<uuid>`. Từ chối ghi khi `ENRICHMENT_PUBLISH_POLICY=auto` (mục từ đủ tầng A sẽ được xuất bản ngay) trừ khi có `--allow-auto`. Lệnh bổ sung ipa_us cho mục từ cũ: `npm run enrich:backfill-ipa` (mục 18.2).

```bash
npm run enrich:review -- [--limit 20] [--unpublished] [--word serendipity]
```
Liệt kê các mục từ tự tạo (`admin_note LIKE '[auto]%'`) kèm `published`, loại từ, số sense, `meaning_vi`, tầng B còn thiếu; `--word` in một mục từ đầy đủ (sense, nghĩa tiếng Việt, ví dụ, dạng biến, `admin_note`). Chỉ đọc. Dùng cho đến khi có trang quản trị ở P8.

Test (không gọi mạng): `tests/enrichment/{pos,assemble,pipeline,p6aFixes}.test.ts`; trên Postgres thật `persist.integration.test.ts` (fixture `qzq<mã>…`, tự xóa); trên dữ liệu `ref_*` thật, chỉ đọc, `pipeline.realdata.test.ts`; `tests/queue/runtime.test.ts`.

## 15. Xử lý sự cố thường gặp

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `npm run worker` thoát mã 1, log `topics_not_seeded` (liệt kê tên thiếu) | Bảng `tags` chưa có đủ 30 chủ đề | Chạy `psql $DATABASE_URL -f docs/seed-topics.sql`; job vẫn nằm trong hàng đợi, không mất |
| Hàng `failed / config_error`, log có `provider` và `http_status` | Thiếu hoặc sai `ANTHROPIC_API_KEY`, hoặc model không tồn tại (401 / 403 / 404) | Sửa khóa hoặc `ANTHROPIC_MODEL_ENRICH`; breaker `anthropic` mở ngay, sau `UPSTREAM_BREAKER_RESET_MS` thử lại. Gửi lại từ bằng `enrich:enqueue` |
| Hàng `skipped / budget` | Hết ngân sách Anthropic (`enforced_spend_limit_reached` hoặc "reached your specified API usage limits") | Nâng giới hạn ở console Anthropic, rồi gửi lại. Breaker mở nên các job khác nhận `breaker_open` và thử lại sau |
| Hàng `failed / upstream_error` sau 4 lần chạy với một từ vô nghĩa | Free Dictionary treo (timeout / 522) với từ không tồn tại, không phải 404 | Đúng thiết kế (lỗi tạm thì ném để thử lại). Từ rác không tốn tiền Haiku. Xem mục 16 |
| `skipped / exists` nhưng không thấy mục từ trên app | Entry có sẵn nhưng `published = false` (chính sách `review`) | `npm run enrich:review -- --unpublished`; duyệt rồi đặt `published = true` |
| `skipped / lemma_mismatch` | Haiku trả lemma khác từ tra (ví dụ `geese` → `goose` khi Wiktionary không có dòng) | Không có entry nào bị tạo. Admin tạo tay, hoặc gửi job cho chính lemma |
| `failed / invalid_output` | Bản nháp vẫn sai sau một lần sửa (xem lỗi bằng `enrich:run --dry-run`) | Chạy lại (Haiku không tất định); nếu lặp lại, xem validator ở mục 7 |
| Mục từ thiếu IPA (`thiếu tầng B: ipa`) | Wiktionary không có IPA hợp lệ nào (kể cả IPA không thẻ), hoặc mục từ tạo trước bản vá 15/10/2026 (khi IPA không thẻ chưa được dùng) | Mục từ cũ: `npm run enrich:backfill-ipa` (dry-run mặc định; mục 18.2). Không có IPA nào thì điền tay |
| Cần chạy lại một từ đã tạo sai | Mục từ tự tạo có sai sót | Xóa mục từ: `DELETE FROM dictionary_entries WHERE id = '<id>' AND admin_note LIKE '[auto]%'` (mọi bảng con, kể cả `word_family_members` và `entry_edit_history`, xóa theo; `word_enrichment_jobs.entry_id` thành NULL); rồi `enrich:run` hoặc `enrich:enqueue` |
| Hai job cùng lemma chờ nhau lâu | Một transaction S6 giữ khóa advisory (database chậm) | Bình thường, mỗi giao dịch cỡ 1 giây; xem `pg_stat_activity` nếu quá vài chục giây |
| `23505` trong log | Job khác vừa ghi cùng lemma | Không cần làm gì: được xử lý như `exists` |

## 16. Quyết định đã tự đưa ra, khác biệt với spec, giới hạn đã biết (P6b)

**Quyết định**
1. **`sense_order` là một số chạy cho cả mục từ** (0, 1, 2...), theo thứ tự của Haiku (phổ biến nhất trước). Mục từ cũ đánh số theo từng loại từ (`noun 0, verb 0, noun 1, verb 1`); app chỉ `ORDER BY sense_order`, nên số chạy chung giữ đúng thứ tự phổ biến và vẫn thỏa `UNIQUE (entry_id, pos, sense_order)`.
2. **Sense lấy từ Haiku, không ghép với sense Wiktionary**, trừ đồng / trái nghĩa (ghép theo độ trùng định nghĩa, ngưỡng 0,25). Lý do ở mục 12.
3. **IPA không có thẻ giọng chỉ là bước CUỐI** (đổi ngày 15/10/2026; trước đó không được dùng). Thứ tự: Wiktionary có thẻ US → Free Dictionary (như spec) → IPA hợp lệ đầu tiên không có thẻ nào, làm `ipa_us`, kèm `[ipa-untagged]` trong `admin_note`; `ipa_uk` không bao giờ lấy từ IPA không thẻ. Lý do: trong `ref_wiktionary_en`, 38.610 / 81.763 dòng có IPA hợp lệ (47%) không có IPA gắn US hoặc UK, và 38.089 trong số đó (99%) có IPA không thẻ. Xem mục 18.2.
4. **Audio ghi URL tuyệt đối** (mục 1.2). Dài quá 500 ký tự thì bỏ, không cắt (cắt làm hỏng URL).
5. **Token ghi vào `word_enrichment_jobs` và `api_usage_counters` là mọi token đầu vào đã tính tiền**: đầu vào mới + ghi cache + đọc cache. System prompt (khoảng 7,9K token) gần như luôn là "đọc cache", nên chỉ đếm đầu vào mới sẽ giấu phần lớn khối lượng. `api_usage_counters`: `provider = 'anthropic'`, đơn vị `input_tokens` / `output_tokens`, kỳ `YYYY-MM` (UTC). Đường nhanh vẫn ghi `anthropic_fast` theo ngày.
6. **Dòng log `enrich` do worker ghi** (một dòng mỗi job, có `stages_ms`, `entry_id`, `model`, token), không ghi thêm ở pipeline để tránh log đôi. Lệnh `enrich:run` tự in.
7. **`lemma_mismatch` rộng hơn mô tả**: mọi trường hợp lemma của bản nháp khác từ đang làm giàu (không chỉ khi không có dòng Wiktionary), vì từ tra sẽ không tìm thấy mục từ bằng chính cách viết của nó.
8. **Dạng biến của dạng biến chỉ đi một bước** (`lemma_mismatch`); và entry của lemma chỉ được nối khi khớp headword hoặc lemma (không nối dạng biến vào một entry tìm thấy qua `word_forms`).
9. **Mở rộng cửa sổ Wiktionary cho Haiku**: từ có hơn 8 sense (`run` 22, `light` 43, `bank` 42) gửi 12 sense và ngân sách 4000 token thay vì 6 và 2500. Haiku vẫn viết tối đa 6 sense. Thêm khoảng 1K đến 2K token đầu vào mỗi từ như vậy (cỡ $0,0002).
10. **Dạng nhiều từ và dạng bằng lemma không vào `word_forms`**; tối đa 20 dạng.
11. **Ví dụ của sense** (`sense_examples.source`) ghi `ai_enrichment`.

**Khác biệt đã sửa vào docs**
- `dictionary_entries.meaning_vi`: migration 01 ghi `NOT NULL`, nhưng DB dev thật cho phép NULL (đo 15/10/2026, `information_schema`). Mã không dựa vào ràng buộc: ghi `meaning_vi` luôn khác rỗng (lỗi thì `invalid_output`).
- Spec S1 nói Free Dictionary lỗi tạm thì ném để thử lại; với từ rác Free Dictionary treo nên kết quả là `failed / upstream_error` sau các lần thử, không phải `rejected / unknown_word` (quyết định giữ đúng spec, mục 15).
- Spec §9.8 đã có vòng tròn; bổ sung cách bỏ trùng, dừng và dự phòng. §10.7 aliases: nghĩa còn lại SAU KHI trừ nghĩa đã nằm trong `meaning_vi`.
- Breaker: `BudgetExceeded` của nhà cung cấp mở breaker (trước là trung tính); lỗi 400 về `output_config` không mở (trước là có, làm hỏng bước dự phòng).
- `docs/lookup-spec.md` §9.4: cửa sổ Wiktionary 6 sense / 2500 token, hoặc 12 / 4000 token khi hơn 8 sense.

**Giới hạn đã biết**
- Nghĩa tiếng Việt sinh ra vẫn cần người duyệt (mục 4 của `docs/lookup-enrichment-samples.md`): nghĩa độn về ý, nghĩa trùng giữa các sense, chủ đề lệch sau khi bỏ `academic_formal`. Với chính sách `review`, mục từ luôn `published = false`.
- Đồng / trái nghĩa của Wiktionary được lọc theo tần suất từ 15/10/2026 (mục 18.3); bộ lọc ưu tiên từ thông dụng nên với từ hiếm có thể giữ từ chung chung hơn từ chính xác (ví dụ `ephemeral`: giữ `short`, `volatile`; bỏ `transitory`, `evanescent`, vì chúng nằm ngoài top 5 theo tần suất). Từ lạ nhưng có trong `ref_word_frequency` (như `hap`) vẫn qua bộ lọc khi sense có ít hơn 5 ứng viên phổ biến hơn.
- `word_families` và `entry_synonyms` chỉ nối tới entry đã có tại thời điểm tạo; entry tạo sau không quay lại nối (việc cho P7 nếu cần).
- Neon (Singapore) từ máy dev: S6 cỡ 0,8 đến 1,8 giây, S1 cỡ 0,5 đến 2 giây.
- Một job lỗi ở S6 rồi thử lại sẽ gọi Haiku lần nữa (không lưu bản nháp). Hiếm; mỗi lần cỡ $0,001.

**Việc còn tồn**
- P7: gắn lịch `reconcileStaleJobs`; nối lại `entry_synonyms` / `word_families` cho entry cũ. (Đã làm ở 15/10/2026: IPA không thẻ, mục 18.2.)
- P8: trang quản trị duyệt mục từ (`published`, sửa nghĩa, xem `admin_note`), lọc `[auto]`; phân quyền theo `admin_accounts.role`.


## 17. Mục từ đã tạo thật ở P6b (DB dev, `ENRICHMENT_PUBLISH_POLICY=review`, 15/10/2026)

Sáu từ chạy bằng `enrich:run` (`quarantine` qua hàng đợi và `npm run worker`). Tất cả `published = false`, `source = 'wiktionary'`, `created_by` NULL, `admin_note` bắt đầu bằng `[auto]`. Số dòng đo bằng SQL sau khi ghi (thêm một dòng `entry_edit_history` mỗi mục từ):

| Từ | published | pos | cefr | rank | ipa | audio | etymology | entry_senses | sense_examples | word_forms | sense_synonyms | sense_antonyms | entry_synonyms | entry_tags | entry_answer_aliases | collocations | tầng B thiếu |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| serendipity | false | noun | C1 | 40016 | us+uk | us+uk | có | 1 | 2 | 1 | 4 | 3 | 2 | 1 | 0 | 1 | - |
| ephemeral | false | adjective,noun | C1 | 29260 | - | us | có | 4 | 8 | 1 | 13 | 7 | 0 | 1 | 3 | 2 | ipa, is_countable |
| podcast | false | noun,verb | B2 | 5615 | us+uk | uk | có | 2 | 2 | 3 | 1 | 0 | 0 | 2 | 0 | 0 | - |
| karaoke | false | noun,verb | B1 | 16507 | uk | uk | có | 3 | 3 | 5 | 1 | 0 | 0 | 2 | 0 | 1 | - |
| run | false | verb,noun,adjective | A1 | 309 | us+uk | us | có | 5 | 6 | 5 | 9 | 3 | 0 | 3 | 4 | 1 | - |
| quarantine | false | noun,verb | B2 | 12306 | us+uk | us | có | 2 | 2 | 5 | 2 | 1 | 0 | 2 | 0 | 1 | - |

Các từ này nằm trong DB dev để bạn duyệt (`npm run enrich:review`). Xóa mục từ nào để chạy lại: xem mục 15.

### Ví dụ một mục từ hoàn chỉnh (`karaoke`, đọc từ DB, rút gọn một số chuỗi dài)

```json
{
  "dictionary_entries": {
    "headword": "karaoke",
    "lemma": "karaoke",
    "pos": [
      "noun",
      "verb"
    ],
    "ipa_us": null,
    "ipa_uk": "/ˈkæ.ɹiˌəʊ.ki/",
    "audio_us_url": null,
    "audio_uk_url": "https://upload.wikimedia.org/wikipedia/commons/transcoded/2/2d/LL-Q1860_%28eng%29-Vealhurl…",
    "meaning_vi": "karaoke; buổi hát karaoke; hát karaoke; quán karaoke",
    "meaning_en": "A form of entertainment in which people sing along to recorded instrumental vers…",
    "example_en": "We spent the evening singing karaoke with friends.",
    "example_vi": "Chúng tôi dành cả buổi tối hát karaoke cùng bạn bè.",
    "cefr_level": "B1",
    "frequency_rank": 16507,
    "register": null,
    "is_countable": true,
    "is_transitive": false,
    "etymology": "Borrowed from Japanese カラオケ (karaoke), from 空(から) (kara, “empty”) + オケ (oke, “or…",
    "source": "wiktionary",
    "published": false,
    "created_by": null,
    "admin_note": "[auto] nguồn: wiktionary, ref_word_frequency, haiku · model: claude-haiku-5-5 · job: cli-caf3373c-94d8-419b-b0b3-b4ce4b1a3b2c · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=B1 · ghi chú của Haiku: Dữ liệu không có từ đồng nghĩa hay trái nghĩa từ Datamuse; để trống. | Nghĩa tập thể dục (exe…"
  },
  "entry_senses": [
    {
      "sense_order": 0,
      "pos": "noun",
      "definition_en": "A form of entertainment in which people sing along to record…",
      "definition_vi": "karaoke; hát karaoke",
      "register": null,
      "grammar_note": "Thường dùng không đếm được; khi chỉ một buổi hát t…",
      "examples": [
        {
          "example_en": "We spent the evening singing karaoke with friends.",
          "example_vi": "Chúng tôi dành cả buổi tối hát karaoke cùng bạn bè.",
          "source": "ai_enrichment"
        }
      ],
      "synonyms": []
    },
    {
      "sense_order": 1,
      "pos": "noun",
      "definition_en": "A single session of singing karaoke, or a place where karaok…",
      "definition_vi": "buổi hát karaoke; quán karaoke",
      "register": null,
      "grammar_note": "Danh từ đếm được.",
      "examples": [
        {
          "example_en": "There is a popular karaoke down the street.",
          "example_vi": "Có một quán karaoke nổi tiếng ngay cuối phố.",
          "source": "ai_enrichment"
        }
      ],
      "synonyms": [
        "noraebang"
      ]
    },
    {
      "sense_order": 2,
      "pos": "verb",
      "definition_en": "To perform karaoke by singing along to a recorded backing tr…",
      "definition_vi": "hát karaoke",
      "register": "informal",
      "grammar_note": "Động từ nội động; chia thêm đuôi -ing và -ed.",
      "examples": [
        {
          "example_en": "After dinner, they karaoked until midnight.",
          "example_vi": "Sau bữa tối, họ hát karaoke đến nửa đêm.",
          "source": "ai_enrichment"
        }
      ],
      "synonyms": []
    }
  ],
  "word_forms": [
    "karaokes (plural)",
    "karaokes (third_person_singular)",
    "karaokeing (present_participle)",
    "karaoked (past_participle)",
    "karaoked (past_simple)"
  ],
  "entry_tags": [
    "arts_entertainment",
    "sports_recreation"
  ],
  "entry_answer_aliases": [],
  "collocations": [
    {
      "collocation": "go to karaoke",
      "pattern": "verb + noun"
    }
  ],
  "entry_edit_history": [
    {
      "field_name": "auto_created",
      "admin_id": null,
      "new_value": {
        "job_id": "cli-caf3373c-94d8-419b-b0b3-b4ce4b1a3b2c",
        "sources": [
          "wiktionary",
          "ref_word_frequency",
          "haiku"
        ],
        "model": "claude-haiku-5-5"
      }
    }
  ]
}
```

`karaoke` chỉ có `ipa_uk`: Wiktionary chỉ gắn thẻ UK cho IPA của nó (dòng US chỉ có phiên âm `enpr`). `is_transitive: false` đến từ thẻ `intransitive` của Wiktionary, không phải từ Haiku. `meaning_vi` ghép vòng tròn nghĩa thứ nhất của 3 sense rồi nghĩa thứ hai, bỏ `hát karaoke` trùng.


## 18. Bản vá sau P6b (15/10/2026)

Bốn việc nhỏ, không đổi hành vi nghiệp vụ khác. Không xóa dữ liệu, không sửa mục từ `published = true`, không thêm biến môi trường hay bảng.

### 18.1 Dòng sai `ran` trong mục từ `run` (CHƯA sửa, chờ xác nhận)

Chỉ SELECT. Mục từ `run` (id `2482567c-2724-4cca-9e64-255da45ec515`, published = false) có **hai** dòng `ran` trong `word_forms`:

| id | form_type | sort_order | Ghi chú |
|---|---|---|---|
| `4e30d917-9d86-4030-86dc-f0d960f03a85` | `past_simple` | 2 | đúng |
| `9af0825c-4730-46c6-b1c7-54096c6d59df` | `third_person_singular` | 3 | **sai**: ô bảng chia động từ có thẻ `["past","singular","third-person"]` (quá khứ, ngôi 3 số ít), tức là `past_simple`; đọc sai trước khi vá `inferFormType` |

Bộ gộp hiện tại đã đúng: với dữ liệu Wiktionary thật của `run` nó chỉ tạo `runs:third_person_singular`, `running:present_participle`, `ran:past_simple`, `runs:plural`. Dòng sai là tồn dư từ trước bản vá, và là dòng duy nhất như vậy.

**Vì sao không UPDATE về `past_simple` được:** ràng buộc `word_forms_entry_id_form_type_form_value_key UNIQUE (entry_id, form_type, form_value)` đã có dòng `(run, past_simple, ran)`, nên UPDATE sẽ lỗi `23505`. Theo thẻ, giá trị đúng của dòng này chính là `past_simple` (dữ liệu Wiktionary chỉ có một ô `participle past` và nó mang thẻ `colloquial`, `nonstandard`, bộ gộp cố ý bỏ). Hai cách xử lý, chưa chạy cách nào:

```sql
-- A (khuyến nghị): xóa đúng dòng trùng sai. CẦN BẠN CHO PHÉP, vì prompt cấm xóa.
BEGIN;
DELETE FROM word_forms
 WHERE id = '9af0825c-4730-46c6-b1c7-54096c6d59df'
   AND entry_id = '2482567c-2724-4cca-9e64-255da45ec515'
   AND form_value = 'ran' AND form_type = 'third_person_singular'
   AND EXISTS (SELECT 1 FROM word_forms ok
                WHERE ok.entry_id = word_forms.entry_id AND ok.form_value = 'ran' AND ok.form_type = 'past_simple')
RETURNING id, entry_id, form_type, form_value;
-- phải ra ĐÚNG 1 dòng, nếu không thì ROLLBACK;
COMMIT;

-- B (chỉ UPDATE, không xóa): chuyển sang past_participle, giá trị DUY NHẤT còn lại không vi phạm UNIQUE.
-- Nhưng "ran" làm quá khứ phân từ là cách dùng phi chuẩn (thẻ nonstandard), nên dòng này sẽ nói sai với người học.
BEGIN;
UPDATE word_forms
   SET form_type = 'past_participle'
 WHERE id = '9af0825c-4730-46c6-b1c7-54096c6d59df'
   AND entry_id = '2482567c-2724-4cca-9e64-255da45ec515'
   AND form_value = 'ran' AND form_type = 'third_person_singular'
RETURNING id, entry_id, form_type, form_value;
-- phải ra ĐÚNG 1 dòng, nếu không thì ROLLBACK;
COMMIT;
```

### 18.2 IPA: IPA không thẻ là bước cuối

**Thứ tự cho `ipa_us`:** (1) IPA Wiktionary gắn `US` hoặc `General-American`; (2) như trước: Free Dictionary (`us`, rồi `any` khi cả `us` và `uk` đều thiếu); (3) **cuối cùng**: IPA hợp lệ đầu tiên của Wiktionary **không có thẻ nào** (không `tags`, không `raw_tags`), và `admin_note` có thêm `[ipa-untagged] ipa_us lấy từ IPA đầu tiên không gắn thẻ giọng của Wiktionary, không rõ giọng`. `ipa_uk` **không bao giờ** lấy từ IPA không thẻ. IPA gắn thẻ giọng khác (Australia, Scotland...) hay thẻ `rare` không phải "không thẻ": không dùng. Có IPA không thẻ thì `ipa` không còn nằm trong "thiếu tầng B". Lọc các mục từ này: `WHERE admin_note LIKE '%[ipa-untagged]%'`.

**Số đo trên `ref_wiktionary_en` (15/10/2026):** 81.763 dòng có IPA hợp lệ; 38.093 có IPA gắn US; 43.670 không. Trong 43.670 dòng đó: 38.997 có IPA không thẻ; 38.610 không có IPA gắn US lẫn UK, và 38.089 trong số này có IPA không thẻ (99%). Ví dụ `ephemeral`: `{"ipa":"/ɛˈfɛ.mə.ɹəl/"}`, `{"ipa":"/əˈfɛ.mə.ɹəl/"}` không có thẻ; thẻ `US` nằm ở phần tử audio.

**Lệnh bổ sung cho mục từ cũ** (không gọi AI, không gọi mạng):

```bash
npm run enrich:backfill-ipa                      # dry-run (mặc định)
npm run enrich:backfill-ipa -- --dry-run         # như trên, nói rõ
npm run enrich:backfill-ipa -- --confirm         # ghi, trong MỘT transaction
npm run enrich:backfill-ipa -- --word ephemeral  # chỉ một lemma
```

Chỉ mục từ tự tạo (`[auto]` trong `admin_note`) còn thiếu `ipa_us` **và** `published = false` (mục từ đã published không bao giờ bị sửa, chỉ được liệt kê). Dùng đúng các dòng Wiktionary mà bộ gộp dùng (`selectEntryRows`), cùng thứ tự: IPA US trước, rồi IPA không thẻ; `ipa_uk` không bao giờ bị đụng. Mỗi mục từ đổi: UPDATE có các điều kiện canh (còn `ipa_us IS NULL`, `published = FALSE`, `[auto]`), bỏ `ipa` khỏi phần "thiếu tầng B", thêm `[ipa-untagged]` khi là IPA không thẻ, và hai dòng `entry_edit_history` (`ipa_us` cũ NULL / mới; `admin_note` cũ / mới), `admin_id` NULL. Không xóa gì. Chạy hai lần: lần hai không làm gì.

**Kết quả dry-run trên DB dev (15/10/2026, chưa chạy `--confirm`):**

```text
automatic entries without ipa_us : 5
  would get an IPA              : 5  (tagged US: 0, untagged: 5)
  no usable IPA in Wiktionary   : 0
  published, left alone         : 0
ephemeral  /ɛˈfɛ.mə.ɹəl/      karaoke    /ˌkæ.ɹiˈoʊ.ki/     table      /ˈteɪbl̩/
reap       /ˈɹiːp/            electrify  /ɪˈlɛktɹɪfaɪ/
```

### 18.3 Đồng nghĩa và trái nghĩa lấy từ Wiktionary

Cho **mục từ mới** (không sửa mục đã có). Khi `collectSources` đọc dòng Wiktionary, nó gom mọi từ đồng / trái nghĩa dạng từ đơn không có dấu nháy (`collectRelatedWords`) và tra `ref_word_frequency` bằng MỘT câu truy vấn thêm (`SourceBundle.relatedRanks`; lỗi truy vấn thì bỏ qua, mục từ chỉ không có từ của Wiktionary). `assembleEntry` rồi lọc danh sách của sense Wiktionary khớp nhất (`filterWiktionaryRelated`):

1. chỉ giữ từ **có trong `ref_word_frequency`**;
2. bỏ cụm từ nhiều từ và từ có dấu nháy hay ngoặc kép (`murphy's law`, `perfect storm`, `ne’er`);
3. xếp **tần suất giảm dần** (rank nhỏ trước; bằng nhau giữ thứ tự của Wiktionary);
4. **tối đa 5** mỗi loại; bỏ headword, lemma và trùng.

Lựa chọn của Haiku vẫn đứng sau và **không bị lọc**; tổng mỗi loại vẫn tối đa 8. Prompt gửi cho Haiku không đổi. Dữ liệu thật:

| Từ | Wiktionary liệt kê | Giữ lại |
|---|---|---|
| serendipity (đồng nghĩa) | chance, luck, adventure, accident, casualty, chance-medley, fortune, hap | chance, luck, accident, adventure, fortune (hạng tần suất 548, 1.312, 1.979, 3.205, 4.303). `casualty` (12.739) và `hap` (27.486) CÓ trong danh sách tần suất nhưng rơi vì giới hạn 5; `chance-medley` bị bỏ vì không có trong danh sách |
| serendipity (trái nghĩa) | Murphy's law, perfect storm | (rỗng, cả hai là cụm từ) |
| ephemeral (đồng nghĩa) | temporary, transitory, fleeting, evanescent, momentary, short-lived, short, volatile | short (472), temporary (3.143), volatile (10.968), fleeting (19.087), momentary (26.170); `transitory` (42.959) và `evanescent` (79.500) rơi vì giới hạn 5, `short-lived` không có trong danh sách |

Hai lưu ý, đều là hệ quả của quy tắc được yêu cầu chứ không phải lỗi: (1) `ephemeral`: ưu tiên tần suất giữ `short`, `volatile` (thông dụng nhưng chung chung) và bỏ `transitory`, `evanescent` (đúng nghĩa hơn). (2) Bộ lọc chỉ loại từ **không có** trong `ref_word_frequency`; từ lạ nhưng có trong danh sách (`hap` hạng 27.486, `casualty` hạng 12.739) vẫn qua và chỉ rơi khi đã đủ 5 từ phổ biến hơn. Với một sense chỉ có 1 đến 4 ứng viên, `hap` sẽ được giữ. Nếu muốn chặt hơn thì thêm ngưỡng hạng tối đa (ví dụ 20.000); chưa làm vì ngoài phạm vi yêu cầu.

### 18.4 Ước tính chi phí: tính từng lần gọi

`generateDraft` giờ trả thêm `callUsage` (token của TỪNG lần gọi Haiku, cùng thứ tự với `callMs`). `estimateDraftCostUsd(model, calls)` (`services/enrichment/pricing.ts`) tính từng lần rồi cộng; `enrich:draft` và `enrich:run` in "(2 lần gọi: $a + $b)". Trước đây token của hai lần gọi được cộng dồn rồi mới tính giá; trang giá nói "mỗi request được tính giá riêng" và mức giá prompt trên 100K token áp dụng cho từng request, nên cộng trước có thể tính sai mức giá. Với prompt thực tế (khoảng 8K đến 12K token mỗi lần gọi) hai cách ra cùng số, nên đây là sửa cho đúng chứ không đổi số liệu trong các mẫu đã chạy.

**Đối chiếu bảng giá** (trang https://platform.claude.com/docs/en/about-claude/pricing, 15/10/2026) với `MODEL_PRICES`: Claude Haiku 5.5, prompt đến 100K token: vào $0.10, ra $0.50, ghi cache 5 phút $0.125, đọc cache $0.01 mỗi triệu token. Prompt trên 100K: $0.50 / $2.50 / $0.625 / $0.05. **Không lệch.** Ngày kiểm tra ghi trong code: `PRICING_CHECKED_ON = 2026-10-15`.

### 18.5 Test

`tests/enrichment/ipaAndRelated.test.ts` (thứ tự IPA, dấu `[ipa-untagged]`, không điền `ipa_uk`, bộ lọc đồng / trái nghĩa), `relatedRanks.test.ts` (tra tần suất khi thu thập nguồn), `backfillIpa.test.ts` (kế hoạch, dry-run không ghi, transaction, lịch sử, lỗi), `backfillIpa.integration.test.ts` (Postgres thật, fixture `qzq<mã>…` tự xóa), `pricing.test.ts` (từng lần gọi, ví dụ `podcast` 2 lần gọi, ngưỡng 100K, bảng giá).
