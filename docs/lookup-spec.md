WORDYGO · ĐẶC TẢ TRA TỪ NHANH VÀ TỰ BỔ SUNG TỪ ĐIỂN
Tệp: docs/lookup-spec.md · Phiên bản 1.5 · 16/10/2026 (1.5: vá sau P8 — mục 1 và 10.3 ĐỔI MẶC ĐỊNH ENRICHMENT_PUBLISH_POLICY từ auto sang review, mục 5 F11 và F12 chạy nền sau khi đã trả response, mục 12.1 thêm hai dòng log; 1.4: P8 — mục 12.6 phân quyền trang quản trị; 1.3: P6b — mục 3 meaning_vi, 8 S2, 8.1 IPA / audio / sense, 9.4 cửa sổ Wiktionary, 9.8 vòng tròn, 10.7, 11.2 / 11.4 breaker, 12.1; 1.2: mục 9.5 chốt khóa đầu ra ở P6a; 1.1: thêm LOOKUP_FAST_TRANSLATOR, chế độ haiku ở mục 5)
Mọi prompt P1 đến P8 dựa vào tệp này. Khi mâu thuẫn, thứ tự ưu tiên: migration thật, tệp này, prompt.

0. QUY TẮC LÀM VIỆC
0.1 Đọc code hiện có trước khi viết. Bám cấu trúc thư mục, logger, framework test và lint sẵn có.
0.2 Migration thật (01_auth_content.ts và các tệp sau) là nguồn sự thật về cột. Nếu khác tệp này: theo migration, ghi chênh lệch vào docs/lookup-schema-notes.md và báo lại.
0.3 Không đổi hành vi endpoint hiện có ngoài phạm vi. Response chỉ được THÊM trường, không đổi tên, không xóa, để app cũ vẫn chạy.
0.4 Code, tên biến, commit, comment: tiếng Anh. Tài liệu trong docs/: tiếng Việt.
0.5 Test tự động không gọi mạng thật (mock, fixture). Script smoke chạy tay phải che khóa API khi in.
0.6 Không in hoặc commit khóa API. Log mức info không chứa nội dung đầy đủ trả về từ dịch vụ ngoài.
0.7 Cuối mỗi prompt: chạy typecheck, lint, test và báo kết quả. Không tự commit, không push.
0.8 Điều chưa chắc (tên cột, hành vi API, tên tùy chọn thư viện): kiểm tra bằng đọc code, curl thật hoặc tài liệu chính thức. Không đoán.

1. BIẾN MÔI TRƯỜNG
Tên khớp 100% với Phần 1B. Kiểm tra bằng zod ở module cấu hình; sai thì dừng khi khởi động. Boolean nhận true hoặc false.
TRANSLATION_FALLBACK_ENABLED=true
ENRICHMENT_ENABLED=false
ENRICHMENT_WORKER_ENABLED=true
ENRICHMENT_PUBLISH_POLICY=review
LOOKUP_UPSTREAM_TIMEOUT_MS=2500
LOOKUP_TOTAL_DEADLINE_MS=3000
LOOKUP_MAX_MEANINGS=4
LOOKUP_TRANSLATE_DEFINITIONS=true
LOOKUP_FAST_TRANSLATOR=google
LOOKUP_MISS_RATE_LIMIT_PER_MIN=20
GOOGLE_TRANSLATE_API_KEY=
GOOGLE_TRANSLATE_BASE_URL=https://translation.googleapis.com/language/translate/v2
GOOGLE_TRANSLATE_MONTHLY_CHAR_LIMIT=450000
GOOGLE_TRANSLATE_MAX_DEFINITION_CHARS=160
FREE_DICTIONARY_BASE_URL=https://api.dictionaryapi.dev/api/v2/entries/en
FREE_DICTIONARY_MAX_REQUESTS_PER_5MIN=400
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL_ENRICH=claude-haiku-5-5
ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH=4000
ANTHROPIC_TIMEOUT_MS_ENRICH=60000
DATAMUSE_ENABLED=true
########################## SOS
DATAMUSE_BASE_URL=https://api.datamuse.com
DATAMUSE_API_KEY=
PGBOSS_SCHEMA=pgboss
PGBOSS_POOL_MAX=5
ENRICHMENT_WORKER_CONCURRENCY=2
ENRICHMENT_JOB_RETRY_LIMIT=3
ENRICHMENT_JOB_RETRY_DELAY_SECONDS=30
ENRICHMENT_MAX_JOBS_PER_DAY=500
UPSTREAM_BREAKER_FAILURE_THRESHOLD=5
UPSTREAM_BREAKER_RESET_MS=30000
REFDATA_DATABASE_URL=
THAY ĐỔI SO VỚI BẢN 1.4 trở về trước: mặc định của ENRICHMENT_PUBLISH_POLICY là review (các bản trước ghi auto). Không đặt biến, hoặc để trống, thì mục từ do job tạo luôn có published=false và chờ quản trị viên duyệt. Muốn tự xuất bản khi đủ tầng A phải đặt RÕ ENRICHMENT_PUBLISH_POLICY=auto trong môi trường của tiến trình worker. Giá trị khác auto và review vẫn làm ứng dụng dừng khi khởi động.
LOOKUP_FAST_TRANSLATOR chỉ nhận google (mặc định) hoặc haiku; haiku bắt buộc ANTHROPIC_API_KEY (thiếu thì dừng khi khởi động, giống ENRICHMENT_ENABLED=true). Mô hình Haiku lấy từ ANTHROPIC_MODEL_ENRICH, timeout bằng LOOKUP_UPSTREAM_TIMEOUT_MS.
Khóa trống: GOOGLE_TRANSLATE_API_KEY trống thì coi Google tắt (cảnh báo một lần khi khởi động). ANTHROPIC_API_KEY trống mà ENRICHMENT_ENABLED=true thì dừng khi khởi động. DATAMUSE_API_KEY trống thì vẫn gọi không khóa, và cảnh báo nếu ngày hiện tại từ 2027-01-01 trở đi.

2. BẢNG MỚI
Một migration kế tiếp theo đúng quy ước hiện có (SQL thuần, IF NOT EXISTS, không sửa bảng cũ).
ref_wiktionary_en
  id BIGSERIAL PRIMARY KEY
  word TEXT NOT NULL (chữ thường)
  pos TEXT NOT NULL
  etymology_number INT NULL
  lemma_of TEXT NULL (từ gốc nếu dòng là dạng biến: form_of hoặc alt_of)
  data JSONB NOT NULL (bản rút gọn của dòng kaikki, xem P4)
  INDEX (word); INDEX (lemma_of) WHERE lemma_of IS NOT NULL
ref_word_frequency
  word TEXT PRIMARY KEY, zipf REAL NOT NULL, rank INT NOT NULL (1 = phổ biến nhất)
word_enrichment_jobs
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4()
  word TEXT NOT NULL
  status VARCHAR(20) NOT NULL, CHECK trong ('queued','running','succeeded','rejected','failed','skipped')
  reason TEXT NULL (mã ngắn, danh sách đầy đủ ở docs/lookup-queue.md: unknown_word, proper_noun, not_english, variant_form, lemma_mismatch, exists, form_linked, daily_cap, budget, invalid_output, upstream_error, invalid_word, duplicate, queue_error, config_error, dead_letter, stale; pipeline_not_ready đã nghỉ hưu từ P6b: chỗ gắn rỗng của P5 không còn, hàng cũ có thể còn mã này; bảng mã cuối cùng ở docs/lookup-enrichment.md mục 11)
  attempts INT NOT NULL DEFAULT 0
  entry_id UUID NULL REFERENCES dictionary_entries(id) ON DELETE SET NULL
  requested_by UUID NULL REFERENCES users(id) ON DELETE SET NULL
  model TEXT NULL, input_tokens INT NULL, output_tokens INT NULL
  created_at, updated_at TIMESTAMPTZ DEFAULT NOW() (gắn trigger update_updated_at sẵn có); finished_at TIMESTAMPTZ NULL
  UNIQUE INDEX (word) WHERE status IN ('queued','running')
api_usage_counters
  provider TEXT, period TEXT (UTC: YYYY-MM hoặc YYYY-MM-DD), unit TEXT (chars, jobs, input_tokens, output_tokens)
  used BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW()
  PRIMARY KEY (provider, period, unit). Tăng nguyên tử: INSERT ... ON CONFLICT DO UPDATE SET used = api_usage_counters.used + EXCLUDED.used
Nếu REFDATA_DATABASE_URL có giá trị: hai bảng ref_* nằm ở DB đó, các bảng còn lại ở DB chính.
Thêm (IF NOT EXISTS) index tra cứu nếu chưa có: lower(headword), lower(lemma) trên dictionary_entries; lower(form) trên word_forms.

3. BẢNG HIỆN CÓ (theo mô tả của chủ dự án; migration thật quyết định tên cột)
dictionary_entries: headword, lemma, pos[], ipa_us, ipa_uk, audio_us_url, audio_uk_url, meaning_vi (migration 01 ghi NOT NULL nhưng DB dev thật cho phép NULL, đo 15/10/2026; job ghi chỉ ghi giá trị khác rỗng), meaning_en, example_en, example_vi, cefr_level (A1 đến C2), frequency_rank, register, is_countable, is_transitive, etymology, source (stardict, wiktionary, manual, user), published, admin_note, created_by, created_at, updated_at. UNIQUE (headword, lemma).
Bảng con theo entry_id: entry_senses (pos, sense_order, definition_en, definition_vi, register, domain, grammar_note, usage_note, region); sense_examples (example_en, example_vi); word_forms (form, loại dạng, ipa, audio_url); entry_synonyms, entry_antonyms (nối entry với entry); sense_synonyms, sense_antonyms (lưu chữ); entry_tags + tags; entry_edit_history; entry_answer_aliases; entry_idioms; phrasal_verbs; collocations; word_families + word_family_members.
Tra cứu: word_lookups (user_id, entry_id, source, ebook_id, ...); user_reading_progress.words_looked_up.
word_translation_cache: NGỪNG đọc và ghi. KHÔNG xóa bảng (để quay lui).
App hiển thị definition_vi của sense đầu tiên; thiếu thì dùng dictionary_entries.meaning_vi.
headword là dạng hiển thị, lemma là dạng gốc. Dạng biến của một từ được nối vào entry gốc qua word_forms, không tạo entry trùng nội dung.
Phân tầng trường cho mục từ MỚI:
  Tầng A, thiếu thì published=false: headword, lemma, pos (từ 1 giá trị), meaning_vi, từ 1 sense có definition_en và definition_vi, từ 1 ví dụ có example_en và example_vi.
  Tầng B, thiếu vẫn xuất bản và ghi vào admin_note: ipa_us hoặc ipa_uk, cefr_level, frequency_rank, is_countable (khi có nghĩa danh từ), is_transitive (khi có nghĩa động từ), từ 1 tag, etymology.
  Tầng C, có thì thêm: audio, word_forms, đồng nghĩa và trái nghĩa, entry_answer_aliases, idioms, phrasal_verbs, collocations, word_families.

4. HỢP ĐỒNG API TRA TỪ
Giữ nguyên đường dẫn, xác thực và các bước đang có. Dưới đây chỉ là phần đổi hoặc thêm.
4.1 Mã trả về: 200 source='dictionary'; 200 source='translation' (bản tạm); 400 từ không hợp lệ (hiện có); 404 ENTRY_NOT_FOUND (hiện có); 429 LOOKUP_RATE_LIMITED (mới, kèm header Retry-After); 503 (mã lỗi hiện có).
4.2 Trường MỚI của bản tạm. Nếu response hiện tại đã có trường cùng ý nghĩa dưới tên khác (ví dụ translation_vi, ipa, pos), giữ tên cũ và đúng vị trí cũ, chỉ thêm phần còn thiếu:
  temporary: true
  headword: string
  pos: string[]
  ipa: string | null
  audio_url: string | null
  translation_vi: string | null   các nghĩa nối bằng '; ', tối đa LOOKUP_MAX_MEANINGS; null khi không có bản dịch; TUYỆT ĐỐI không lặp lại từ gốc
  meanings_vi: string[]   các nghĩa ngắn đã loại trùng
  senses: [ { pos, definition_en, definition_vi | null, gloss_vi | null, example_en | null } ]   tối đa LOOKUP_MAX_MEANINGS phần tử
  partial: boolean   true khi thiếu dữ liệu vì một nguồn lỗi hoặc không có
  missing: string[]   ví dụ ['translation_vi'] hoặc ['pos','definition_en','ipa','audio_url']
  attribution: [ { name, license, url } ]
  enrichment: { status: 'queued' | 'already_queued' | 'skipped' | 'disabled', reason?: string }
4.3 Bản từ điển (source='dictionary'): giữ nguyên; thêm matched_form (string) khi khớp qua word_forms hoặc qua dạng biến.
4.4 Header Cache-Control: no-store cho mọi bản tạm. Bản tạm không bao giờ được ghi vào bảng từ điển hay vào cache nào.
4.5 Ghi response cuối cùng vào docs/lookup-api.md.

5. ĐƯỜNG NHANH (đồng bộ)
F1 Làm sạch từ (giữ logic hiện có): bỏ dấu câu hai đầu, kiểm tra hợp lệ, chữ thường. Sai thì 400.
F2 Nếu có paragraph_id: xác nhận đoạn thuộc ebook (giữ nguyên).
F3 Tăng words_looked_up chạy ngầm (giữ nguyên, không chặn response).
F4 Tra từ điển trong các entry published=true theo thứ tự: headword, lemma, word_forms.form.
F4b Chưa khớp: tra ref_wiktionary_en (word = từ, lemma_of khác NULL) để tìm lemma; nếu entry published của lemma đó có thì trả entry đó kèm matched_form, đồng thời ghi ngầm một dòng word_forms cho dạng này (ON CONFLICT DO NOTHING). Bảng ref rỗng thì bỏ qua bước này.
   Khớp ở F4 hoặc F4b: trả source='dictionary', ghi word_lookups kết quả dictionary, dừng. Số lần gọi dịch vụ ngoài: 0.
F5 TRANSLATION_FALLBACK_ENABLED=false: trả 404 ENTRY_NOT_FOUND, ghi word_lookups not_found.
F6 Giới hạn tần suất theo người dùng cho các lần chạm đi tới bước này (LOOKUP_MISS_RATE_LIMIT_PER_MIN; bộ nhớ trong tiến trình là đủ). Vượt: 429 LOOKUP_RATE_LIMITED kèm Retry-After.
F7 Single-flight theo từ đã chuẩn hóa: nhiều request cùng từ đang chạy dùng chung MỘT lần gọi ngoài. Không đọc, không ghi word_translation_cache. Không có cache kết quả.
F8 Bước 1, song song, mỗi nguồn timeout LOOKUP_UPSTREAM_TIMEOUT_MS:
    a) Google dịch mảng [từ] sang tiếng Việt, ra headline_vi.
    b) Free Dictionary lấy entry (IPA, audio, pos, định nghĩa, ví dụ).
F9 Bước 2, khi LOOKUP_TRANSLATE_DEFINITIONS=true, Free Dictionary có dữ liệu, ngân sách ký tự Google còn, và còn thời gian trước LOOKUP_TOTAL_DEADLINE_MS:
    Chọn tối đa LOOKUP_MAX_MEANINGS sense đa dạng: nghĩa đầu của mỗi loại từ trước, rồi nghĩa thứ hai của loại từ chính.
    Gửi MỘT request Google, mỗi phần tử q = '<từ>: <định nghĩa tiếng Anh, cắt tối đa GOOGLE_TRANSLATE_MAX_DEFINITION_CHARS ký tự>'.
    Tách mỗi kết quả tại dấu ':' đầu tiên. Phần trước = gloss_vi (nghĩa ngắn đúng theo sense). Phần sau = definition_vi.
    Hạ chữ thường chữ cái đầu của gloss_vi. Bỏ gloss nếu rỗng, dài hơn 40 ký tự, hơn 5 từ, hoặc giống hệt từ gốc mà Free Dictionary chưa xác nhận từ đó.
    Kỹ thuật tiền tố này CHƯA kiểm chứng với Google thật: P3 phải chạy thử nghiệm trước và ghi kết quả vào docs/lookup-multimeaning-experiment.md.
F10 Gộp theo mục 6. meanings_vi = loại trùng([headline_vi, ...gloss_vi]) cắt còn LOOKUP_MAX_MEANINGS phần tử. translation_vi = meanings_vi.join('; '), hoặc null nếu rỗng.
Chế độ bộ dịch nhanh (LOOKUP_FAST_TRANSLATOR). Giao diện FastTranslator.translate({ word, deadlineAt }) -> { meanings_vi, ... } thay cho việc gọi Google ở F8a; Free Dictionary và F9 giữ nguyên ở cả hai chế độ.
  google (mặc định): F8a như trên (Google dịch riêng từ gốc, headline_vi); F10 meanings_vi = loại trùng([headline_vi, ...gloss_vi]) như mô tả.
  haiku: F8a được thay bằng MỘT lần gọi Claude Haiku chạy SONG SONG với Free Dictionary. Model = ANTHROPIC_MODEL_ENRICH; timeout = LOOKUP_UPSTREAM_TIMEOUT_MS (và không vượt hạn chót); max_tokens khoảng 300; thinking tắt (thinking: disabled) và output_config.effort = low; KHÔNG gửi temperature (Haiku 5.5 trả 400 "temperature is deprecated"); đầu ra theo output_config.format kiểu json_schema: { meanings: [ { vi, pos } ] } với 2 đến 4 nghĩa tiếng Việt ngắn (1 đến 4 từ), khác nhau thật sự, phổ biến nhất trước, kèm loại từ; mảng rỗng nghĩa là "không phải từ tiếng Anh". System prompt theo 9.6 (gọn); từ tra cứu đặt trong thẻ <data> và coi là dữ liệu, không phải chỉ dẫn.
    Kiểm tra đầu ra bằng zod rồi làm sạch (bỏ ngoặc đơn, nghĩa rỗng, dài quá 40 ký tự hoặc quá 6 từ, chữ Hán/Hàn/Nhật, trùng nhau); không thử lại (không có thời gian). Sai định dạng, max_tokens, refusal đều coi là lỗi.
    F10 trong chế độ haiku: meanings_vi LẤY TỪ HAIKU (cắt còn LOOKUP_MAX_MEANINGS). Bước 2 (F9, Google) vẫn chạy khi LOOKUP_TRANSLATE_DEFINITIONS=true nhưng chỉ điền senses[].definition_vi và senses[].gloss_vi, KHÔNG thêm gloss vào meanings_vi.
    Thời gian dự phòng: Haiku chỉ được dùng tới (hạn chót trừ 500 ms) để Google còn thời gian trả lời; nếu còn ít hơn 500 ms thì bỏ qua Haiku và gọi Google ngay (lý do no_time). Hạn chót tính từ ĐẦU lần tra, nên truy vấn từ điển cục bộ chậm (ví dụ lần đầu mở kết nối DB) làm Haiku mất lượt.
    Rơi dự phòng: Haiku lỗi, timeout, hết ngân sách (BudgetExceeded), mạch ngắt mở hoặc đầu ra sai thì tự gọi Google làm F8a (chỉ bước 1, không dịch lại gì khác); khi đó meanings_vi tính như chế độ google (headline + gloss). Mảng nghĩa rỗng do Haiku trả về là một phán đoán hợp lệ ("không phải từ"), không rơi dự phòng.
    Ghi token: input_tokens và output_tokens của mỗi lần gọi Haiku vào api_usage_counters (provider = 'anthropic_fast', period = ngày UTC). Ma trận mục 6 không đổi: G = bộ dịch cho ra ít nhất một nghĩa dùng được.
    Mạch ngắt riêng cho đường nhanh (không dùng chung với job làm giàu) để lỗi timeout ngắn của đường nhanh không khóa job nền.
F11 Nếu ENRICHMENT_ENABLED và từ đáng tin (mục 7): gửi job. Lỗi hàng đợi chỉ ghi log, không làm hỏng response.
    Từ spec 1.5, việc GỬI chạy NỀN, sau khi response đã được trao cho nơi gọi, và không ai chờ nó. Response mang quyết định tại thời điểm trả lời: disabled (ENRICHMENT_ENABLED=false), skipped với reason unknown_word (từ không đáng tin, mục 7), hoặc queued (đã giao cho khâu gửi nền; đây là lời hứa thử gửi, không phải biên nhận). Kết quả thật của lần gửi (queued, already_queued, skipped với daily_cap, ...) chỉ nằm ở log { evt:'lookup_enrich' } (mục 12.1). Lần gửi ném lỗi ghi một dòng { evt:'lookup_background_error', task:'enrich' } mức error và không đổi response; vì từ vẫn chưa có trong từ điển, lần tra sau của từ đó tự thử gửi lại. Phép kiểm "từ đáng tin" vẫn chạy trước response, và chỉ truy vấn DB khi Free Dictionary chưa xác nhận từ.
F12 Ghi word_lookups: translation (200) hoặc not_found (404, 503). Từ spec 1.5 cũng chạy nền sau response (mọi nhánh, kể cả dictionary); lỗi ghi { evt:'lookup_background_error', task:'word_lookups' } và không đổi response.
Giới hạn thời gian: tổng không vượt LOOKUP_TOTAL_DEADLINE_MS; hết hạn thì trả những gì đã có và đặt partial=true.
    Hạn chót chỉ bao các truy vấn cục bộ và các cuộc gọi ra ngoài. Trước spec 1.5, việc gửi job (một giao dịch pg-boss, khoảng 0,5 giây với DB ở xa) và ghi word_lookups nằm SAU hạn chót mà vẫn trước response, nên đẩy p95 vượt LOOKUP_TOTAL_DEADLINE_MS + 500 ms. Nay hai việc đó chạy sau response nên không cộng vào thời gian người dùng chờ. LOOKUP_TOTAL_DEADLINE_MS và biên 500 ms của nghiệm thu không đổi.

6. MA TRẬN GỘP KẾT QUẢ
G = Google có bản dịch dùng được: khác rỗng; nếu giống hệt từ gốc thì chỉ tính khi Free Dictionary xác nhận từ tồn tại (từ vay mượn như taxi).
F = Free Dictionary có entry. FD404 = Free Dictionary trả 404. FDerr = Free Dictionary lỗi (timeout, 5xx, 429, breaker mở, hết lượt nội bộ).
  F và G           -> 200 đầy đủ
  F, không G       -> 200 partial; translation_vi=null; missing có translation_vi
  G, FD404         -> 200 partial; missing có pos, definition_en, ipa, audio_url
  G, FDerr         -> 200 partial; như dòng trên
  không G, FD404   -> 404 ENTRY_NOT_FOUND; word_lookups not_found; KHÔNG gửi job
  không G, FDerr   -> 503 (mã lỗi hiện có); word_lookups not_found; nếu ENRICHMENT_ENABLED và từ đáng tin thì gửi job với startAfter 60 giây (từ spec 1.5: kiểm từ và gửi đều chạy nền sau khi 503 đã đi; dòng log lookup ghi enrichment_status = deferred)
Lỗi cũ phải hết: không bao giờ điền translation_vi bằng chính từ vừa tra khi Google lỗi.

7. ĐIỀU KIỆN VÀ CÁCH GỬI JOB
Từ đáng tin = Free Dictionary có entry, hoặc có dòng trong ref_wiktionary_en, hoặc có dòng trong ref_word_frequency.
Hàng đợi: dictionary.enrich_word (pg-boss 12). Hàng lỗi chết: dictionary.enrich_word.dlq, tạo trước.
Chính sách hàng đợi exclusive (tối đa một job đang chờ hoặc đang chạy cho mỗi singletonKey); singletonKey = từ đã chuẩn hóa; retryLimit = ENRICHMENT_JOB_RETRY_LIMIT; retryDelay = ENRICHMENT_JOB_RETRY_DELAY_SECONDS; retryBackoff = true.
Dữ liệu job nhỏ: { word, requestedBy, ebookId }.
Quy trình gửi: kiểm tra trần ENRICHMENT_MAX_JOBS_PER_DAY, ghi hàng word_enrichment_jobs (queued), gọi boss.send. send trả null nghĩa là đã có job cho từ này: enrichment.status = already_queued.
Tên tùy chọn của pg-boss phải đối chiếu với phiên bản cài thật và tài liệu tại pgboss.io (api/queues, api/jobs, api/workers).

8. LÀM GIÀU (job nền): các giai đoạn
S0 Kiểm tra tồn tại nhanh, chưa khóa (khóa tư vấn chỉ lấy trong transaction ghi ở S6, mục 10.1, để không giữ transaction mở trong lúc chờ các cuộc gọi ngoài). Nếu đã có entry (published hay không) khớp headword, lemma hoặc word_forms: status skipped, reason exists.
S1 Thu thập, song song, mỗi nguồn có timeout và được phép thiếu:
   Wiktionary cục bộ: ref_wiktionary_en theo word, rồi theo lemma_of nếu từ là dạng biến.
   Tần suất: ref_word_frequency.
   Datamuse: đồng nghĩa và trái nghĩa, nếu DATAMUSE_ENABLED.
   Free Dictionary: chỉ khi Wiktionary không có dòng nào. Lỗi tạm thời (không phải 404) thì ném lỗi để pg-boss thử lại.
S2 Quyết định lemma. Nếu Wiktionary cho biết từ là dạng biến của lemma L:
   Entry của L đã có (khớp headword hoặc lemma): chỉ thêm dạng biến vào word_forms (nếu chưa có). status succeeded, reason form_linked. Loại dạng biến không xác định được (9 giá trị của CHECK) thì không ghi gì: skipped, reason exists.
   Chưa có: thu thập nguồn (S1) LẦN HAI cho chính L (dòng Wiktionary, tần suất, ứng viên Datamuse của L), làm giàu cho L (headword = L, lemma = L) rồi thêm dạng biến vào word_forms trong cùng transaction. Chỉ đi một bước: L lại là dạng biến của L2 thì skipped, reason lemma_mismatch.
   Một từ có nghĩa riêng (running: cả danh từ, tính từ) không phải dạng biến thuần: được làm giàu như từ thường.
   Mọi dòng Wiktionary của từ là lỗi chính tả hoặc dạng lỗi thời, phi chuẩn (tag misspelling, obsolete, archaic, nonstandard, dialectal, rare, proscribed): status skipped, reason variant_form, KHÔNG gọi Haiku. Không nguồn nào nhận ra từ (không dòng Wiktionary, Free Dictionary 404, không có trong ref_word_frequency): status rejected, reason unknown_word, KHÔNG gọi Haiku.
S3 Gọi Haiku (mục 9) với dữ liệu đã thu thập.
S4 Kiểm tra đầu ra (mục 9.7). Danh từ riêng hoặc không phải tiếng Anh: status rejected, reason proper_noun hoặc not_english. variant_of khác null: skipped, reason variant_form. Lemma của bản nháp khác từ đang làm giàu (P6b: mọi trường hợp, không chỉ khi không có dòng Wiktionary, vì từ tra sẽ không tìm thấy mục từ bằng chính cách viết của nó): skipped, reason lemma_mismatch (không tạo mục từ, để admin xử lý). Vẫn sai sau một lần sửa: failed, reason invalid_output.
S5 Gộp theo bảng ưu tiên nguồn (mục 8.1), xếp tầng A, B, C, quyết định published.
S6 Ghi DB trong MỘT transaction (mục 10).
S7 Cập nhật word_enrichment_jobs (trạng thái, entry_id, token), api_usage_counters, log.

8.1 BẢNG ƯU TIÊN NGUỒN THEO TRƯỜNG (1 = ưu tiên cao nhất)
  headword, lemma, pos          1 Wiktionary; 2 Free Dictionary; 3 Haiku
  ipa_us, ipa_uk                1 Wiktionary sounds có thẻ giọng (US, General-American / UK, Received-Pronunciation, Southern-England; giữ dấu gạch chéo, bỏ ngoặc vuông và IPA cụt); 2 Free Dictionary; 3 để NULL (không để Haiku bịa IPA). IPA không có thẻ giọng không được dùng (47% dòng Wiktionary có IPA mà không có IPA gắn US hoặc UK; xem docs/lookup-enrichment.md mục 16)
  audio_us_url, audio_uk_url    1 Wiktionary (mp3_url trước, ogg_url sau; giọng theo thẻ, không có thì theo tên tệp en-us-* / En-uk-*); 2 Free Dictionary; 3 NULL. Ghi URL TUYỆT ĐỐI (app truyền nguyên giá trị vào just_audio); URL dài quá 500 ký tự thì bỏ, không cắt
  definition_en                 1 Wiktionary glosses; 2 Free Dictionary; Haiku được viết lại cho gọn và dễ hiểu nhưng không đổi nghĩa
  meanings_vi, definition_vi    Haiku (nhiều nghĩa ngắn, mục 9)
  example_en                    1 Wiktionary examples; 2 Free Dictionary; 3 Haiku tạo mới nếu không có
  example_vi                    Haiku
  cefr_level                    Haiku (ước tính, tham chiếu zipf); ghi rõ là ước tính trong admin_note
  frequency_rank                ref_word_frequency.rank; thiếu thì NULL
  register, domain, region, grammar_note, usage_note    1 Wiktionary tags; 2 Haiku. P6b: lấy từ Haiku (đã thấy thẻ Wiktionary; danh sách sense của Haiku đã viết lại và đổi thứ tự nên không ghép 1-1 với Wiktionary), register chỉ trong 7 giá trị của CHECK
  is_countable, is_transitive   1 Wiktionary (head_templates, senses.tags); 2 Haiku
  etymology                     Wiktionary etymology_text (cắt tối đa 1000 ký tự); không có thì NULL
  word_forms                    Wiktionary forms (kèm ipa, audio nếu có)
  sense_synonyms, sense_antonyms    Wiktionary senses (sense khớp nhất theo độ trùng định nghĩa tiếng Anh, đứng trước); Haiku (đã thấy ứng viên Datamuse; Datamuse không ghi trực tiếp). Chữ thường, loại trùng, khác headword, tối đa 8 mỗi loại
  entry_synonyms, entry_antonyms    chỉ nối tới entry ĐÃ CÓ trong dictionary_entries (khớp lemma); không tạo entry mới chỉ để nối
  entry_tags                    Haiku, chỉ chọn trong 30 tên của bảng tags, tối đa 3
  entry_idioms, phrasal_verbs, collocations, word_families    Wiktionary derived, related cộng Haiku; chỉ khi chắc chắn; tối đa 5 mỗi loại

9. HỢP ĐỒNG GỌI CLAUDE HAIKU
9.1 Model lấy từ ANTHROPIC_MODEL_ENRICH. Không ghi cứng tên model trong code.
9.2 Đầu ra có cấu trúc: dùng output_config.format kiểu json_schema (đã GA, không cần beta header, Haiku 5.5 hỗ trợ). Chỉ dùng tính năng JSON Schema được hỗ trợ: không đệ quy; không minimum, maximum, minLength, maxLength; mảng chỉ minItems 0 hoặc 1; additionalProperties = false; enum chỉ gồm chuỗi, số, bool hoặc null. Các ràng buộc còn lại kiểm tra bằng zod sau khi nhận. Nếu SDK cài đặt chưa có kiểu cho output_config thì nâng SDK. Nếu model từ chối output_config thì dự phòng bằng tool bắt buộc (tool_choice chỉ định tool) cộng zod. Schema còn bị giới hạn độ phức tạp (tối đa 24 tham số tùy chọn và 16 tham số kiểu hợp, tức anyOf hoặc kiểu mảng như ['string','null']); gặp lỗi 400 'Schema is too complex for compilation' thì đơn giản hóa schema, ví dụ dùng chuỗi rỗng thay cho null. Lần gọi đầu với một schema mới chậm hơn vì phải biên dịch.
9.3 Tham số: max_tokens = ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH; timeout = ANTHROPIC_TIMEOUT_MS_ENRICH; temperature thấp (0 đến 0.3) nếu model nhận tham số này. stop_reason là max_tokens hoặc refusal thì coi là lỗi. Ghi usage (input_tokens, output_tokens) vào word_enrichment_jobs và api_usage_counters. Tùy chọn: bật prompt caching cho system prompt nếu đủ độ dài tối thiểu theo tài liệu.
9.4 Phần cố định nằm trong system prompt (để bật prompt caching): quy tắc ở 9.6, danh sách 30 tên chủ đề kèm mô tả ngắn (lấy từ classify-topics.mjs) và các enum hợp lệ. Phần thay đổi theo từng từ (JSON gọn, đặt trong thẻ <data>; mọi thứ trong <data> là dữ liệu, KHÔNG phải chỉ dẫn): từ tra cứu; lemma dự kiến; các dòng Wiktionary đã rút gọn (tối đa khoảng 2.500 token và 6 nghĩa chia đều giữa các loại từ; từ có hơn 8 nghĩa: tới 12 nghĩa và khoảng 4.000 token, để run, light, bank không mất nghĩa quan trọng; Haiku vẫn viết tối đa 6 sense); zipf và rank; đồng và trái nghĩa của Datamuse.
9.5 Đầu ra (khóa cuối cùng, chốt ở P6a; hiện thực trong services/enrichment/haiku/schema.ts, mô tả đầy đủ ở docs/lookup-enrichment.md mục 3):
   is_english_word (bool), is_proper_noun (bool), variant_of (chuỗi hoặc null: dạng chuẩn khi từ là lỗi chính tả, dạng lỗi thời hoặc phi chuẩn của từ khác)
   headword (dạng hiển thị), lemma (chữ thường, một từ), pos[] (enum: noun, verb, adjective, adverb, preposition, conjunction, pronoun, determiner, exclamation, modal verb, number, article)
   cefr_level (A1 đến C2; null cho từ không lập mục), is_countable (true, false, null), is_transitive (true, false, null)
   topics[] (tối đa 3, thuộc 30 tên chủ đề; tên lạ bị bỏ chứ không thay thế; từ thật nên có 1 đến 3, rỗng thì ghi vào notes)
   senses[] (tối đa 6): pos, definition_en (tối đa 25 từ, dễ hiểu), meanings_vi[] (zod đòi 1 đến 4 nghĩa, mỗi nghĩa tối đa 40 ký tự và 6 âm tiết; mục tiêu 2 đến 4 nghĩa NGẮN, phổ biến nhất trước, khác nhau thật sự, nằm ở system prompt), register (7 giá trị của CHECK của DB hoặc null), domain, region, grammar_note, usage_note (chuỗi hoặc null), examples[] (1 đến 2 cặp { example_en, example_vi }), synonyms[], antonyms[] (tối đa 8 mỗi loại)
   idioms[] { idiom_text, definition_en, definition_vi, example_en, example_vi }; phrasal_verbs[] { phrasal_verb, particle, is_separable, definition_en, definition_vi, example_en, example_vi }; collocations[] { collocation, pattern, example_en, example_vi } (cột thật của entry_idioms, phrasal_verbs, collocations; tối đa 5 mỗi loại; được phép rỗng)
   notes_for_review[] (điểm Haiku không chắc)
   Từ không lập mục (is_english_word false, hoặc is_proper_noun true, hoặc variant_of khác null): senses, pos, topics, idioms, phrasal_verbs, collocations là mảng rỗng; cefr_level, is_countable, is_transitive là null.
9.6 Quy tắc tiếng Việt cho system prompt (kế thừa prompt dịch đã dùng ở import-oxford.mjs):
   - Văn phong từ điển Anh-Việt chuẩn mực như Oxford Learner's phiên bản tiếng Việt; không khẩu ngữ.
   - Lấy NHIỀU nghĩa: mỗi sense có 2 đến 4 nghĩa ngắn, khác nhau thật sự, sắp theo mức phổ biến, không bao giờ quá 4. Không lặp ý bằng cách đổi sang từ gần như đồng nghĩa. Chỉ 1 nghĩa khi tiếng Việt thật sự chỉ có một cách nói, và ghi lý do vào notes_for_review.
   - Không dùng ngoặc đơn để giải thích thêm; không thêm giải thích ngoài lề. Sắc thái, lĩnh vực, vùng miền ghi vào trường register, domain, region.
   - Thuật ngữ chuyên ngành: dùng thuật ngữ tiếng Việt tương đương.
   - Ví dụ dịch tự nhiên theo ngữ cảnh, không dịch từng chữ, giữ nguyên sắc thái.
   - Không bịa IPA, audio hay từ nguyên. Không chắc thì để null hoặc ghi vào notes_for_review.
   - Từ thô tục hoặc miệt thị: vẫn dịch trung thực và đặt register là vulgar hoặc offensive.
9.7 Kiểm tra sau khi nhận (zod cộng luật bổ sung): enum hợp lệ; topics chỉ thuộc 30 tên (tên lạ thì bỏ, không thay bằng academic_formal); meanings_vi có từ 1 đến 4 phần tử, mỗi nghĩa không rỗng, tối đa 40 ký tự và 6 âm tiết, không có ngoặc đơn, không trùng nhau sau khi chuẩn hóa chữ hoa và khoảng trắng, không chứa chữ Hán, Hàn, Nhật, không giống hệt từ tiếng Anh ở toàn bộ phần tử; example_vi khác example_en; cefr_level hợp lệ. Sai thì thử lại MỘT lần kèm danh sách lỗi; vẫn sai thì job failed, reason invalid_output, không thử thêm.
9.8 Gom nghĩa: definition_vi của mỗi sense = meanings_vi.join('; ') (tối đa 4 nghĩa). dictionary_entries.meaning_vi lấy nghĩa theo vòng tròn: nghĩa thứ nhất của từng sense (theo thứ tự sense), rồi nghĩa thứ hai của từng sense, và cứ thế; bỏ nghĩa trùng (so sánh sau khi chuẩn hóa bằng normalizeVietnameseAnswer: chữ thường, bỏ dấu câu hai đầu, gộp khoảng trắng); dừng khi đủ 6 nghĩa hoặc khi thêm một nghĩa nữa sẽ vượt 200 ký tự ('; ' tính vào độ dài); nối bằng '; '. Nhờ vậy từ chỉ có một sense vẫn hiển thị nhiều nghĩa ở trường dự phòng. Nếu kết quả rỗng thì dùng nghĩa đầu của sense đầu; nếu vẫn rỗng thì hủy mục từ (failed, invalid_output). Không bao giờ ghi meaning_vi rỗng (cột được coi là NOT NULL dù DB dev cho phép NULL). Hiện thực: buildMeaningVi trong services/enrichment/assemble.ts.

10. GHI DATABASE
10.1 Một transaction duy nhất. Lấy pg_advisory_xact_lock(hashtextextended('enrich:' || lemma, 0)). Kiểm tra lại sự tồn tại trước khi ghi.
10.2 dictionary_entries: source='wiktionary'; created_by=NULL; published theo 10.3; admin_note bắt đầu bằng '[auto]' rồi liệt kê: nguồn đã dùng, model, id job, trường tầng B còn thiếu, trường là ước tính (cefr_level), notes_for_review.
10.3 published: ENRICHMENT_PUBLISH_POLICY='review' thì false. 'auto' thì true khi đủ tầng A, ngược lại false. Mặc định khi không đặt biến là 'review' (đổi từ 'auto' ở bản 1.5, xem mục 1).
10.4 Thứ tự ghi bảng con: entry_senses (sense_order bắt đầu từ 0 như dữ liệu thật; P6b dùng MỘT số chạy cho cả mục từ theo thứ tự của Haiku, còn mục từ cũ đánh số theo từng loại từ), sense_examples, word_forms, sense_synonyms, sense_antonyms, entry_synonyms, entry_antonyms, entry_tags, entry_answer_aliases, entry_idioms, phrasal_verbs, collocations, entry_edit_history.
10.5 entry_edit_history: một dòng field_name='auto_created', admin_id=NULL, new_value = JSON ngắn gồm id job, nguồn, model.
10.6 dictionary_entries.meaning_en = definition_en của sense đầu; example_en, example_vi = ví dụ đầu của sense đầu; pos[] = loại từ theo thứ tự xuất hiện, loại trùng.
10.7 entry_answer_aliases: các nghĩa của mọi sense còn lại SAU KHI trừ những nghĩa đã nằm trong dictionary_entries.meaning_vi (so sánh bằng normalized_answer); normalized_answer = normalizeVietnameseAnswer, source = 'ai_accepted', status = 'active'. Chỉ mục duy nhất (entry_id, normalized_answer) chỉ áp khi status = 'active' nên ghi bằng INSERT ... WHERE NOT EXISTS, không dùng ON CONFLICT.
10.8 Idempotent: chạy lại cùng job không tạo bản ghi trùng; dùng ON CONFLICT, không xóa rồi ghi. Cắt chuỗi theo độ dài cột (VARCHAR(255), VARCHAR(500)) trước khi ghi để không gặp lỗi 22001.
10.9 Riêng tư: dữ liệu job không chứa email, tên hay nội dung đoạn văn của người dùng.

11. CHỊU LỖI
11.1 Mọi cuộc gọi ngoài dùng AbortSignal.timeout. Đường nhanh: tối đa 1 lần thử lại cho lỗi mạng tạm thời, chỉ khi còn trong LOOKUP_TOTAL_DEADLINE_MS. Job nền: thử lại theo pg-boss.
11.2 Circuit breaker riêng cho từng nhà cung cấp (google, free_dictionary, datamuse, anthropic): mở sau UPSTREAM_BREAKER_FAILURE_THRESHOLD lỗi liên tiếp; nửa mở sau UPSTREAM_BREAKER_RESET_MS. Khi mở: bỏ qua cuộc gọi và coi như nguồn đó lỗi. 404 của Free Dictionary không phải lỗi. P6b: mở ngay (không cần đủ ngưỡng) khi BudgetExceeded của nhà cung cấp (spend_limit, provider_quota) hoặc lỗi cấu hình 400 / 401 / 403; KHÔNG mở khi 400 chỉ nói model từ chối output_config (UpstreamConfigError.affectsBreaker = false: bước dự phòng tool bắt buộc cần lần gọi thứ hai đi qua breaker) và khi hết bộ đếm ký tự Google của chính ta (monthly_chars).
11.3 Phân loại: 429 tôn trọng Retry-After. 400, 401, 403: lỗi cấu hình, không thử lại, log mức error, mở breaker.
11.4 Anthropic: 429 có retry-after thì chờ rồi thử lại qua pg-boss. 429 có error.details.error_code = enforced_spend_limit_reached, hoặc HTTP 400 có thông báo bắt đầu bằng 'You have reached your specified API usage limits': hết ngân sách, job skipped, reason budget, KHÔNG thử lại, log mức error.
11.5 Free Dictionary: token bucket nội bộ FREE_DICTIONARY_MAX_REQUESTS_PER_5MIN; hết lượt thì coi là FDerr.
11.6 Google: trước khi gọi, đặt chỗ ký tự trong api_usage_counters (provider='google_translate', unit='chars', period='YYYY-MM' theo UTC). Vượt GOOGLE_TRANSLATE_MONTHLY_CHAR_LIMIT thì không gọi và coi như Google lỗi.
11.7 Trần job: ENRICHMENT_MAX_JOBS_PER_DAY (provider='enrichment', unit='jobs', period='YYYY-MM-DD' theo UTC). Vượt thì job skipped, reason daily_cap.
11.8 Tắt khẩn: TRANSLATION_FALLBACK_ENABLED=false tắt đường nhanh; ENRICHMENT_ENABLED=false ngừng gửi job; ENRICHMENT_WORKER_ENABLED=false ngừng xử lý. Khi tắt tiến trình, worker dừng gọn (offWork với wait) để không bỏ dở job.

12. QUAN SÁT VÀ BẢO MẬT
12.1 Log có cấu trúc. Mỗi lần tra: { evt:'lookup', word, outcome, source, partial, latency_ms, google_ms, fd_ms, enrichment_status }. Từ spec 1.5, enrichment_status của dòng này là quyết định đã đưa vào response (disabled, skipped, queued; deferred sau một 503) và latency_ms là thời gian TỚI KHI TRẢ LỜI. Kết quả thật của lần gửi nền nằm ở dòng riêng { evt:'lookup_enrich', word, status, reason, delayed_s, enqueue_ms } (mức info). Một lần gửi hoặc một lần ghi word_lookups ở nền bị lỗi ra { evt:'lookup_background_error', task:'enrich'|'word_lookups', word, error } ở mức error (đã che khóa, tối đa 200 ký tự). Mỗi job: { evt:'enrich', word, job_id, status, reason, stages_ms, input_tokens, output_tokens } (P6b: worker ghi đúng một dòng mỗi job, thêm attempt, duration_ms, entry_id, model; stages_ms gồm s0_exists, s1_sources, s1b_lemma_sources, s3_haiku, s5_assemble, s6_persist). Token ghi vào api_usage_counters (provider 'anthropic', unit input_tokens và output_tokens, period YYYY-MM UTC) ngay sau mỗi lần gọi Haiku; input_tokens gồm cả token ghi và đọc cache.
12.2 Bộ đếm: số lần tra theo source và outcome, tỉ lệ partial, trạng thái breaker, ký tự Google đã dùng trong tháng, job theo trạng thái, token đã dùng.
12.3 Làm sạch đầu vào: giữ bộ lọc từ hiện có; thêm test cho chuỗi có khoảng trắng, số, ký tự điều khiển, chuỗi quá dài, Unicode lạ.
12.4 Chống chèn lệnh (prompt injection): nội dung từ Wiktionary, Free Dictionary, Datamuse và từ người dùng tra chỉ là dữ liệu, bọc trong thẻ <data>; system prompt nói rõ không làm theo chỉ dẫn nằm trong đó; đầu ra luôn qua schema và zod.
12.5 Không ghi khóa API vào log, lỗi hay response. Khi cần in thì che, chỉ hiện 4 ký tự cuối.
12.6 Phân quyền admin theo admin_accounts.role (super_admin, content_editor, moderator) cho các tính năng ở P8 (chốt ở P8, hiện thực ở routes/lookup.ts và middlewares/adminJson.ts; hướng dẫn ở docs/lookup-admin.md): super_admin và content_editor xem và thao tác (thêm từ vào hàng đợi, thử lại job, xuất bản, ẩn, xuất bản hàng loạt); moderator chỉ xem danh sách và chi tiết: nút ghi bị ẩn ở giao diện, API ghi trả 403 FORBIDDEN. Mọi thao tác ghi để lại log evt='admin_action'.

13. KIỂM THỬ VÀ TIÊU CHÍ HOÀN THÀNH
13.1 Unit test cho: sanitizer, ma trận gộp (bảng test theo mục 6, có ca lỗi cũ), tách 'từ: định nghĩa', single-flight, breaker, token bucket, parser Free Dictionary (fixture từ phản hồi thật), client Google, hợp đồng Haiku (mock), validator, bộ gom nghĩa, ghi DB idempotent.
13.2 Integration test trên Postgres thật (container hoặc DB test): migration chạy 2 lần không lỗi; job chạy 2 lần chỉ ra 1 entry; 10 job cùng từ chỉ ra 1 entry; từ dạng biến chỉ thêm word_forms.
13.3 Không test nào phụ thuộc mạng thật hoặc khóa API.
13.4 Một prompt xong khi: typecheck, lint, test đều xanh; không còn TODO ẩn; docs/ đã cập nhật; báo cáo cuối liệt kê tệp đã đổi, quyết định đã tự đưa ra và việc còn tồn.