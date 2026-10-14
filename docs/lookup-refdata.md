# WordyGo · Dữ liệu tham chiếu (ref_*): nạp, kiểm tra, cấu trúc thật

Hai bảng `ref_word_frequency` và `ref_wiktionary_en` là dữ liệu tham chiếu chỉ đọc, nạp **bằng tay một lần** (và nạp lại khi muốn làm mới). Chúng phục vụ: (a) nhận ra một từ có thật, (b) tìm lemma của một dạng biến (`ran` → `run`, bước F4b của đường nhanh), (c) cấp dữ liệu cho bước làm giàu (nghĩa tiếng Anh, IPA, audio, ví dụ, dạng biến, từ nguyên, đồng nghĩa và trái nghĩa).
Số liệu dưới đây đo ngày 14/10/2026 trên bản dump `raw-wiktextract-data.jsonl.gz` (2,98 GB) và `wordfreq` 3.1.1.

## 1. Nơi đặt dữ liệu: DB chính hay DB riêng

**Mặc định: cùng DB chính.** Không đặt `REFDATA_DATABASE_URL` (hoặc để trống). `npm run db:migrate` tạo cả bốn bảng của migration 33 trong DB chính.

**Tùy chọn: DB riêng** (tách dung lượng và sao lưu khỏi DB người dùng):

1. Tạo một database Postgres trống và lấy chuỗi kết nối.
2. Đặt `REFDATA_DATABASE_URL=postgresql://...` (xem `.env.example`).
3. `npm run db:migrate` (bỏ qua hai bảng `ref_*`, in một dòng nhắc), rồi `npm run db:migrate-refdata` để tạo chúng trên DB riêng (chạy lặp lại được).

Các bảng `word_enrichment_jobs` và `api_usage_counters` luôn ở DB chính. Mọi script nạp và kiểm tra bên dưới tự chọn DB theo `REFDATA_DATABASE_URL`, nếu trống thì dùng DB chính, và in `host/tên database` (không in mật khẩu) ở dòng `target:`. Chúng từ chối chạy khi `NODE_ENV=production`.

## 2. Chuẩn bị một lần: môi trường ảo Python và wordfreq

`wordfreq` là thư viện Python (dữ liệu nằm trong gói, **không tải gì từ mạng khi chạy**). Tạo môi trường ảo ở gốc repo (thư mục `.venv` đã tự có `.gitignore`):

```bash
py -m venv .venv                                  # Windows (python3 -m venv .venv trên Linux/macOS)
.venv/Scripts/python -m pip install wordfreq      # Linux/macOS: .venv/bin/python -m pip install wordfreq
```

Script `scripts/refdata/run-python.mjs` tự tìm `.venv/Scripts/python.exe` hoặc `.venv/bin/python`, nên lệnh `npm` dùng được trên cả hai hệ điều hành.

## 3. Các lệnh

Tệp dump `.gz` để ở `data/refdata/raw-wiktextract-data.jsonl.gz` (thư mục `data` đã nằm trong `.gitignore`). Không script nào giải nén ra đĩa.

| Lệnh | Việc |
|---|---|
| `npm run refdata:wordfreq:export` | Ghi `data/refdata/wordfreq-en.tsv` (word, zipf, rank; không tiêu đề). 193.844 dòng, mất vài giây |
| `npm run refdata:wordfreq` | Nạp TSV vào `ref_word_frequency`, lô 5.000 dòng, `ON CONFLICT DO UPDATE` nên chạy lại cho cùng kết quả (~16 giây) |
| `npm run refdata:sample` | Quét dump một lượt, ghi mẫu `tests/fixtures/refdata/wiktionary-sample.jsonl` và thống kê `wiktionary-survey.json` (~3,5 phút) |
| `npm run refdata:wiktionary -- <tham số>` | Nạp `ref_wiktionary_en` (xem dưới) |
| `npm run refdata:verify` | Chỉ đọc: số dòng, dung lượng, kiểm tra 11 từ, thử `resolveViaForms` |

Tham số của `refdata:wiktionary` (sau dấu `--`):

| Tham số | Ý nghĩa |
|---|---|
| `--file <đường dẫn .gz>` | mặc định `data/refdata/raw-wiktextract-data.jsonl.gz` |
| `--top-n <N>` | chỉ giữ từ có rank ≤ N trong `ref_word_frequency` (mặc định 150000) |
| `--limit-lines <N>` | chỉ đọc N dòng đầu (để đo thử) |
| `--reset` | `TRUNCATE ref_wiktionary_en RESTART IDENTITY` trước khi nạp |
| `--dry-run` | chạy đủ bộ lọc và rút gọn nhưng không ghi DB; in thống kê, bảng kích thước theo `--top-n` và 5 bản ghi mẫu |
| `--strict-nonstandard` | `lemma_of` là NULL ngay khi BẤT KỲ sense nào không chuẩn (xem mục 6.3) |

**Thứ tự bắt buộc:** `refdata:wordfreq:export` → `refdata:wordfreq` → `refdata:wiktionary` → `refdata:verify`. Bộ nạp Wiktionary dừng và nhắc nếu `ref_word_frequency` rỗng.

### Nạp bản đầy đủ (chạy nền, lệnh để bạn tự chạy)

```bash
# Git Bash / Linux / macOS
nohup npm run refdata:wiktionary -- --top-n 150000 --reset > data/refdata/wiktionary-import.log 2>&1 &
tail -f data/refdata/wiktionary-import.log          # xem tiến độ
npm run refdata:verify                              # sau khi xong
```

Trên Windows PowerShell: `Start-Process -NoNewWindow -RedirectStandardOutput data\refdata\wiktionary-import.log -RedirectStandardError data\refdata\wiktionary-import.err npm.cmd -ArgumentList "run","refdata:wiktionary","--","--top-n","150000","--reset"`. Có thể dùng `tmux` thay cho `nohup`. Ctrl-C (SIGINT) làm xong lô đang chạy rồi thoát sạch; nhấn lần hai để buộc dừng. Nếu dừng giữa chừng, chạy lại với `--reset`.

## 4. Số đo và ước tính

| | Kết quả |
|---|---|
| Dump | 10.913.999 dòng; **1.492.835 dòng tiếng Anh** (13,7%); 1 dòng JSON hỏng |
| Quét + rút gọn không ghi DB (toàn bộ dump) | **3 phút 24 giây**, 53.448 dòng/giây |
| Tốc độ khi ghi vào DB Neon từ máy dev (300.000 dòng đầu) | **911 dòng đọc/giây** (5 phút 29 giây cho 42.437 dòng giữ), ghi ~130 dòng/giây. Điểm nghẽn là mạng tới Neon (Singapore), không phải CPU |
| Dung lượng trong Postgres (300.000 dòng đầu) | 42.437 dòng = **72 MB** gồm index (1,7 KB mỗi dòng); cột `data` trung bình **1.554 B** lưu nén, 1.841 B dạng JSON |
| Cột `data` trung bình trên toàn bộ dòng sẽ nạp | **850 B** (đo trên cả dump); lớn nhất 8.414 B; 1 dòng vượt 8 KB. Phần đầu tệp nặng hơn (1.769 B) vì chứa các từ thông dụng |

**Số dòng và dung lượng theo `--top-n`** (đo chính xác từ lượt quét toàn bộ dump; dung lượng trên đĩa ước tính từ tỉ lệ nén và phần tử overhead đo được ở trên):

| `--top-n` | Dòng giữ | JSON | Ước tính trên đĩa (có index) |
|---|---|---|---|
| 25.000 | 56.279 | 72 MB | ~70 MB |
| 50.000 | 94.900 | 106 MB | ~110 MB |
| 100.000 | 149.843 | 142 MB | ~150 MB |
| **150.000 (mặc định)** | **189.456** | **164 MB** | **~180 MB** |
| 200.000 | 220.649 | 179 MB | ~200 MB |

**Ước tính lần nạp đầy đủ (`--top-n 150000`)**: 189.456 dòng, **~180 MB** trong `ref_wiktionary_en`. Thời gian: đọc + rút gọn 3,5 phút, cộng ghi vào Neon từ máy dev khoảng 12 đến 25 phút, **tổng khoảng 15 đến 30 phút** (nếu DB ở gần máy chạy, ghi nhanh hơn nhiều). DB chính sau khi nạp: 21 MB (hiện tại) + `ref_word_frequency` 28 MB + ~180 MB ≈ 230 MB.

**Khuyến nghị `--top-n`: giữ 150000.** Từ 100.000 lên 150.000 chỉ thêm 39.600 dòng (+26%) và ~30 MB nhưng phủ thêm nhiều từ ít gặp; lên 200.000 chỉ thêm 31.200 dòng cho các từ có zipf dưới ~2. Dưới 100.000 mất các từ hiếm mà người đọc ebook vẫn chạm vào. Nếu dung lượng DB chính là mối lo, hãy dùng `REFDATA_DATABASE_URL` thay vì giảm `--top-n`.

## 5. Cấu trúc thật của dump

Đã khảo sát bằng `refdata:sample` (một lượt trên toàn bộ dump, không đoán tên trường). Mẫu thật nằm ở `tests/fixtures/refdata/wiktionary-sample.jsonl` (33 dòng: mọi dòng tiếng Anh của `run, ran, running, children, colour, ubiquitous, serendipity, London, recieve, taxi, karaoke` và 10 dòng ngẫu nhiên lấy trong số các từ sẽ được nạp, có dòng kèm `mp3_url`). Dòng quá 50 KB bị bỏ `translations`, `descendants`, `categories` và ghi ở `_sample.trimmed`.

### (i) Chuỗi `lang_code` để lọc nhanh

Dump được ghi theo kiểu Python `json.dumps` (có **dấu cách sau `:` và `,`**). Chuỗi chính xác là:

```
"lang_code": "en"
```

Kiểm tra `line.includes('"lang_code": "en"')` bỏ qua ~86% dòng mà không cần `JSON.parse`. Nó **không bỏ sót dòng tiếng Anh nào**. Nhưng nó cũng khớp các đối tượng lồng bên trong dòng ngôn ngữ khác (ví dụ `descendants` của tiếng Latin): 53.296 trong 1.546.132 dòng qua bộ lọc (3,4%), nên quyết định cuối cùng là `row.lang_code === 'en'` sau khi parse. JSON gọn (`"lang_code":"en"` không dấu cách) **không** khớp. Vị trí khóa thay đổi theo dòng (khi thì `lang_code` đứng cuối, khi thì trước `word`), nên không thể kiểm tra theo vị trí.

### (ii) Khóa cấp cao nhất (trên 1.492.835 dòng tiếng Anh)

Luôn có: `senses`, `pos`, `word`, `lang`, `lang_code`. Còn lại, số dòng có khóa đó:

| Khóa | Số dòng | Khóa | Số dòng |
|---|---|---|---|
| `head_templates` | 1.484.960 | `etymology_text` | 535.572 (36%) |
| `forms` | 580.519 | `etymology_links` | 511.272 |
| `etymology_templates` | 490.949 | `categories` | 296.059 |
| `sounds` | 199.164 (13%) | `translations` | 156.086 |
| `related` | 115.721 | `derived` | 112.227 |
| `synonyms` | 47.322 | `etymology_number` | 44.836 (3%) |
| `hyphenations` | 28.281 | `wikipedia` | 10.897 |
| `antonyms` | 10.185 | `coordinate_terms` | 8.559 |
| `hypernyms` | 6.714 | `hyponyms` | 6.399 |
| `descendants` | 4.749 | `meronyms` / `holonyms` | 909 / 706 |
| `source` | 216 | `instances` | 103 |
| `abbreviations`, `original_title`, `troponyms`, `info_templates`, `hyphenation`, `form_of`, `inflection_templates`, `alt_of` | 1 đến 75 | | |

**Không có khóa `tags` cấp cao nhất** (0 dòng): tag nằm ở cấp sense, form và sound. Giá trị `pos` thường gặp: `noun` 831.965, `verb` 222.221, `name` 200.625 (danh từ riêng), `adj` 186.151, `adv` 27.625, `phrase`, `intj`, `prep_phrase`, `prefix`, `suffix`, `proverb`, `pron`, `contraction`, `prep`, `num`, `symbol`, `conj`, `det`, …

### (iii) Cấu trúc các trường con

- **`etymology_number` là CHUỖI** (`"1"`, `"2"`), không phải số. Bộ rút gọn ép sang số nguyên.
- **`etymology_text`**: chuỗi. Một số dòng có tạp chất ở đầu (ví dụ `London` bắt đầu bằng `Etymology tree\nProto-Celtic …`). 3.013 dòng dài hơn 1.000 ký tự.
- **`senses[]`** (1.787.234 sense): khóa `glosses` (mảng 1 đến 2 chuỗi), `raw_glosses`, `tags`, `raw_tags` (12.627 sense), `examples`, `form_of`, `alt_of`, `synonyms`, `antonyms`, `topics`, `links`, `categories`, `senseid`, `qualifier`, `coordinate_terms`, `hypernyms`, `wikidata`, … 5.266 dòng có hơn 8 sense.
  - `examples[]`: `{ text, ref?, type, bold_text_offsets }`; chỉ 1.859 ví dụ có `translation` và `english` (ví dụ không phải tiếng Anh).
  - `form_of` và `alt_of`: **mảng** `[{ "word": "run" }]`, đôi khi có `extra` (8.436 và 16.748 sense).
  - `synonyms` / `antonyms` của sense và cấp trên: mảng **đối tượng** `{ word, sense?, source? }` (không phải chuỗi). `derived` / `related` cũng vậy (`source: "Thesaurus:run"` xuất hiện ở một số).
- **`forms[]`** (988.644 phần tử): `{ form, tags, source?, links?, head_nr?, raw_tags?, topics? }`. Có phần tử chỉ là dấu hiệu bảng: `{"form":"no-table-tags","tags":["table-tags"]}`, `{"form":"glossary","tags":["inflection-template"]}`, tag `class`; có placeholder `"form": "-"`; bảng chia động từ (`source: "conjugation"`) lặp lại các dạng giống nhau (`run` có 7 lần `ran` trong 28 phần tử). 655 dòng có hơn 20 form.
- **`sounds[]`**: **ipa và audio nằm ở các phần tử RIÊNG**, không bao giờ chung một phần tử. Số phần tử mang khóa: `ipa` 286.536, `audio` / `ogg_url` / `mp3_url` (đều 146.331), `tags` 343.540, `enpr` 22.124, `note`, `rhymes`, `homophone`, `other`, `text`, `zh_pron`. 8.053 dòng có hơn 8 sound, trong đó **884 dòng có bản ghi âm đầu tiên nằm sau vị trí thứ 8** (cắt 8 phần tử đầu sẽ làm mất audio).
- **`head_templates[]`**: `{ name, args, expansion }`. Tên hay gặp: `head` (554.797), `en-noun`, `en-adj`, `en-proper noun`, `en-verb`, `en-adv`, … Ví dụ `expansion`: `"run (third-person singular simple present runs, …)"`, `"children"`, `"recieve"`.

### (iv) Khác biệt so với giả định ở mục 8.1 của spec

| Mục 8.1 nói | Dữ liệu thật |
|---|---|
| IPA: "Wiktionary sounds (tag US, UK)" | Tag giọng thực tế: **US** 87.304 và **General-American** 63.535 (Mỹ); **UK** 30.475, **Received-Pronunciation** 54.022, **Southern-England** 44.804 (Anh); còn Australia 36.963, Canada 14.168, New-Zealand 9.996, Scotland, Wales, India, … Chỉ dùng `US`/`UK` sẽ bỏ sót phần lớn dữ liệu. Một phần tử có thể mang nhiều tag (`["Received-Pronunciation","US"]`, `["Australia","General-American","Received-Pronunciation"]`) |
| Audio: "mp3_url trước, ogg_url sau" | Đúng nhưng `ogg_url` **luôn đi kèm** `mp3_url` (128.724 dòng có cả hai, 0 dòng chỉ có ogg), nên "ogg sau" không bao giờ xảy ra. Cả hai là URL tuyệt đối của Wikimedia Commons (`.../transcoded/.../X.ogg.mp3`) |
| Giọng của audio theo tag | **Nhiều phần tử audio không có tag giọng** (`{"audio":"En-uk-London.ogg", "note":"Gloucestershire", …}`, `{"audio":"En-run.ogg"}`); giọng chỉ suy ra từ tên tệp `en-us-*`, `En-uk-*`, `en-au-*`. Tệp Lingua Libre (`LL-Q1860 (eng)-…wav`) có tag vùng (`Southern-England`) nhưng tên không chứa giọng |
| IPA và audio "kèm ipa, audio" cùng form | Ở `sounds[]` chúng là các phần tử riêng; ghép theo tag/tên tệp, không theo vị trí |
| Chỉ có tag cấp trên | Không có `tags` cấp cao nhất. Tag của sense (1.246.606 sense có), của form và của sound |
| `etymology_number` | Chuỗi, không phải số; chỉ 3% dòng có. `etymology_text` có ở 36% dòng |
| `forms` "kèm ipa, audio nếu có" | `forms[]` không có `ipa` hay `audio` (khóa chỉ có `form, tags, source, links, head_nr, raw_tags, topics`) |
| `synonyms`/`antonyms` "chữ" | Đối tượng `{word, …}`, không phải chuỗi thuần |
| `register` | Sense `tags` chứa `informal` 19.265, `slang` 28.791, `vulgar` 5.097, `offensive` 2.162, `derogatory` 9.215, `dated` 11.498, `obsolete` 40.897, `archaic` 25.059, `humorous` 4.750, … lẫn với tag vùng (`US`, `UK`, `Australia`) và tag ngữ pháp (`transitive`, `countable`, `plural`). `vulgar`/`offensive` vẫn vướng CHECK của `dictionary_entries.register` (xem `docs/lookup-schema-notes.md`) |
| `is_countable` / `is_transitive` | Đúng là nằm ở sense `tags`: `countable` 104.518, `uncountable` 240.178; `transitive` 37.512, `intransitive` 15.024, `ambitransitive` 2.131; và `head_templates` (`en-noun` với `args["1"]` = `"~"` nghĩa là đếm được cả hai) |
| Mã `pos` | `adj`, `adv`, `intj`, `prep`, `conj`, `pron`, `det`, `name`; DB đang dùng `adjective`, `adverb`, `exclamation`, `preposition`, `conjunction`, `pronoun`, `determiner`, `modal verb`, `article`, `number`: cần bảng ánh xạ ở bước làm giàu |

### (v) Tag đánh dấu dạng biến và lỗi chính tả

- **Dạng biến:** sense có `form_of: [{word}]` và tag `form-of` (537.590 lần) cùng các tag ngữ pháp (`plural`, `past`, `participle`, `present`, `gerund`, `third-person`, `singular`, `comparative`, `superlative`, …).
  - `ran` (động từ, `etymology_number: "1"`) có **3 sense**: `["form-of","past"]` → `form_of run`; `["form-of","past"]` → `form_of rin` (lemma khác!); `["colloquial","form-of","nonstandard","participle","past"]` → `form_of run`. Cả ba đều có `form_of`, nhưng sense thứ ba mang tag `nonstandard`.
  - `running` (động từ): một sense `["form-of","gerund","participle","present"]` → `run`. `children`: `["form-of","plural"]` → `child` (sense 2 → `childer`).
- **Dạng thay thế:** `alt_of: [{word}]` và tag `alt-of` (171.126) + `alternative` (94.801).
- **Lỗi chính tả:** `recieve` có một sense `["alt-of","misspelling"]`, `alt_of: [{"word":"receive"}]`, `head_templates` `{"name":"head","args":{"1":"en","2":"misspelling"}}`. Số sense mang tag không chuẩn trên toàn dump: `misspelling` 6.814, `obsolete` 40.897, `archaic` 25.059, `nonstandard` 3.917, `dialectal` 5.212, `rare` 19.169, `proscribed` 858.

## 6. Quy tắc nạp `ref_wiktionary_en`

### 6.1 Giữ dòng nào
`lang_code` là `en`, có `word` và `pos`, và chữ thường của `word` có rank ≤ `--top-n` trong `ref_word_frequency`. Từ nhiều chữ (như `ice cream`) không có trong wordfreq nên không được giữ.

### 6.2 Cột và cột `data`
Cột: `word` = chữ thường; `pos`; `etymology_number` (số nguyên); `lemma_of`; `data` JSONB. **`data.word` giữ nguyên chữ hoa chữ thường** (`London` khác `london`). `data` chỉ giữ: `word`, `pos`, `etymology_number`, `etymology_text` (≤1.000 ký tự), `senses` (≤8; `glosses` ≤4 chuỗi, `tags`, `raw_tags`, `examples` ≤2 với `text`/`translation`, `synonyms`/`antonyms` ≤8 từ, `form_of`, `alt_of`, `topics`; mọi chuỗi ≤250 ký tự), `forms` (≤20, `form` + `tags`, bỏ dấu hiệu bảng, `-` và trùng lặp), `sounds` (≤8, `ipa, tags, mp3_url, ogg_url, audio, enpr`), `head_templates` (≤2, `name` + `expansion` ≤200), `tags` (cấp cao nhất, nếu có), `derived`/`related` (≤20 từ), `synonyms`/`antonyms` (≤8). Bỏ `translations`, `descendants`, `categories` và mọi thứ khác.

Khác prompt gốc ở hai điểm nhỏ, đều có lý do:
- `sounds`: giữ trước tối đa 4 phần tử có ipa và 4 phần tử có audio rồi mới lấp chỗ trống, vì nếu chỉ lấy 8 phần tử đầu thì 884 dòng mất audio.
- `glosses` tối đa 4 chuỗi mỗi sense (thực tế chỉ có 1 đến 2).

### 6.3 `lemma_of` và quy tắc "không chuẩn" (quyết định cần bạn xác nhận)

`lemma_of` chỉ được đặt khi **mọi** sense của dòng đều có `form_of` hoặc `alt_of` (tính trên mọi sense, trước khi cắt còn 8); lấy từ đầu tiên, chữ thường, khác chính từ đó.

Prompt yêu cầu để NULL "nếu BẤT KỲ sense nào mang tag misspelling, obsolete, archaic, nonstandard, dialectal, rare hoặc proscribed". Đọc đúng từng chữ thì dòng `ran` (động từ) sẽ có `lemma_of = NULL` vì sense thứ ba của nó mang tag `nonstandard`, trái với yêu cầu `ran → run` chính trong prompt. Vì vậy mặc định là:

- Sense mang một trong các tag trên **không bao giờ** được dùng để lấy lemma.
- `lemma_of` là NULL khi **mọi** sense đều không chuẩn (đúng với `recieve`, một dòng chỉ có sense `misspelling`), và lấy từ sense chuẩn đầu tiên trong các trường hợp còn lại (`ran` → `run`).

Cờ `--strict-nonstandard` bật đúng nghĩa đen của prompt (BẤT KỲ sense nào). Dòng không chuẩn vẫn được giữ và vẫn mang `form_of`, `alt_of`, `tags` trong `data` để bước làm giàu nhận ra.

### 6.4 Lỗi của P3 đã sửa nhờ dữ liệu thật
`resolveViaForms` ban đầu gom tag của **mọi** sense để đoán loại dạng biến: với `ran` nó đoán `past_participle` (do sense `nonstandard`). Giờ nó chỉ dùng tag của sense chuẩn đầu tiên trỏ tới đúng lemma (`tagsForLemma`), cho `past_simple`. Danh sách tag không chuẩn dùng chung nằm ở `services/lookup/wiktionaryTags.ts`.

### 6.5 Giới hạn đã biết
- `word_forms.form_type` chỉ có 9 giá trị; loại dạng không nhận ra thì không ghi `word_forms` (vẫn trả mục từ).
- Với `--reset` bị ngắt giữa chừng, bảng ở trạng thái dở: chạy lại với `--reset`.
- Chưa thử Ctrl-C thật trên Windows (Node trên Windows không nhận SIGINT từ `kill`); logic dừng được test qua cờ `shouldStop`.
- `scripts/`, `tests/` và `docs/` đang nằm trong `.gitignore` của repo, nên các script này cùng test và tài liệu **không được git theo dõi**.

## 7. Kiểm tra (`npm run refdata:verify`)

In số dòng, số từ riêng biệt, số dòng có `lemma_of`, dung lượng và kích thước trung bình cột `data`, rồi bảng PASS/WARN (WARN chỉ cảnh báo, không làm script thất bại). Kết quả trên dữ liệu thử (300.000 dòng đầu): **11/11 PASS**.

## 8. Ghi chú về `word_translation_cache`

Bảng `word_translation_cache` (migration 26) **không còn dùng** khi đường tra từ mới hoạt động (từ P3): không đọc, không ghi, nhưng **không xóa** để có thể quay lui.
