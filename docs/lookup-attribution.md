# WordyGo · Nguồn dữ liệu, giấy phép và ghi công (tra từ và làm giàu từ điển)

Cập nhật 15/10/2026 (P7b). Tài liệu này ghi **những gì đã đọc được** về điều khoản của từng nguồn dữ liệu mà tính năng tra từ dùng, và **đề xuất nơi** ứng dụng có thể hiển thị ghi công để bạn quyết định.

**Nguyên tắc của tài liệu này**
* Chỉ ghi điều đọc được từ phản hồi thật của dịch vụ, tệp LICENSE, hoặc trang chính thức, kèm nơi đọc và ngày đọc. Điều chưa đọc được ghi rõ là **chưa xác minh**.
* **Không có kết luận pháp lý.** Tôi không nói app có hay không tuân thủ một giấy phép, cũng không nói nội dung sinh ra từ dữ liệu của một nguồn có phải "tác phẩm phái sinh" hay không. Những câu hỏi đó nằm ở mục 5 để bạn (hoặc người có chuyên môn pháp lý) trả lời.
* Trang điều khoản có thể đổi sau ngày đọc. Đọc lại trước khi phát hành.

## 1. Tóm tắt từng nguồn

| Nguồn | Dữ liệu app lấy | Điều đọc được về điều khoản hoặc giấy phép | Nơi đọc (ngày đọc: 15/10/2026 trừ khi ghi khác) |
|---|---|---|---|
| **Free Dictionary API** (`api.dictionaryapi.dev`) | Đường tra nhanh: loại từ, định nghĩa tiếng Anh, ví dụ, IPA, URL audio của bản tạm. Job nền chỉ hỏi dịch vụ này khi Wiktionary cục bộ không có dòng nào cho từ, nên dữ liệu của nó **có thể** vào mục từ do job tạo (xem 2.1) | Mỗi phản hồi thật mang `license` = `{ "name": "CC BY-SA 3.0", "url": "https://creativecommons.org/licenses/by-sa/3.0" }` và `sourceUrls` = URL trang Wiktionary của từ. Từng phần tử `phonetics[]` có thể mang `license` và `sourceUrl` riêng, trỏ về Wikimedia Commons; các giá trị thấy trong 3 mẫu: `BY-SA 3.0`, `BY-SA 4.0`, `BY 3.0 US`. Trang chủ nói API miễn phí và sẽ luôn miễn phí; **không thấy trang điều khoản sử dụng** trong những gì đọc được. Kho mã nguồn của dịch vụ dùng GNU GPL v3 (giấy phép của **phần mềm**, không phải của dữ liệu) | Phản hồi thật đã lưu ở `tests/fixtures/lookup/free-dictionary/{hello,ran,ubiquitous}.json` (chụp 13/10/2026); `https://dictionaryapi.dev/`; `LICENSE` của `github.com/meetDeveloper/freeDictionaryAPI` |
| **Wiktionary** (qua bản dump của Wiktextract, `kaikki.org`) | Bảng `ref_wiktionary_en` (đọc cục bộ, ~189 nghìn dòng): nghĩa và ví dụ tiếng Anh, IPA, dạng biến, từ đồng / trái nghĩa, từ nguyên, URL tệp âm thanh. Job nền dùng nó làm nguồn chính, rồi Haiku dựng mục từ (xem 2.2) | Trang `Wiktionary:Copyrights` nói văn bản gốc của các mục từ được cấp phép kép **CC BY-SA 4.0** và **GFDL**; ai dùng lại phải theo CC BY-SA hoặc GFDL (ghi công theo cách người cấp phép chỉ định, cấp phép lại theo cùng giấy phép hoặc giấy phép tương thích). Trang `kaikki.org/dictionary/rawdata.html` nêu bản hiện hành của trang được trích bằng Wiktextract từ dump enwiktionary ngày 2026-09-02 (ngày dump của tệp đang dùng ở đây chưa được ghi lại), và nhờ trích dẫn bài báo của Tatu Ylonen **khi dùng trong nghiên cứu học thuật**. `LICENSE` của Wiktextract: **mã** dưới MIT; một số tệp trong `tests/` dưới giấy phép Wiktionary | `https://en.wiktionary.org/wiki/Wiktionary:Copyrights`; `https://kaikki.org/dictionary/rawdata.html`; `LICENSE` của `github.com/tatuylonen/wiktextract` |
| **Tệp âm thanh trên Wikimedia Commons** (URL ghi trong `audio_us_url` / `audio_uk_url`) | Chỉ **URL tuyệt đối** của tệp; app phát thẳng từ Wikimedia, không sao chép tệp | Giấy phép **khác nhau theo từng tệp**. Năm tệp đã tra bằng API của Commons khi làm P6b: `En-us-serendipity.ogg` (CC BY-SA 3.0, cần ghi tác giả Dvortygirl), `En-uk-serendipity.ogg` (CC0, không cần ghi), `En-us-ephemeral.ogg` (CC BY-SA 3.0, EncycloPetey), `En-us-ran.ogg` (CC BY-SA 3.0, Dvortygirl), `LL-Q1860 (eng)-Vealhurl-karaoke.wav` (CC BY-SA 4.0, Vealhurl). Không thấy cột nào trong DB lưu tên tác giả hay giấy phép của audio | API `commons.wikimedia.org` (kết quả đã ghi lúc P6b); `docs/lookup-enrichment.md` mục 1.2 |
| **wordfreq** (bảng `ref_word_frequency`) | Hạng tần suất của từ (`frequency_rank`), dùng khi dựng mục từ do job tạo (kể cả ước tính CEFR) và khi tra cục bộ | README ghi **mã** dưới Apache 2.0 (`LICENSE.txt`: Copyright 2022 Robyn Speer) và các **tệp dữ liệu** "có thể được phân phối lại dưới CC BY-SA 4.0". Dữ liệu tổng hợp từ nhiều nguồn có giấy phép riêng: Leeds Internet Corpus, Wikipedia, ParaCrawl, OPUS OpenSubtitles 2018 ("có thể dùng khi ghi công OpenSubtitles"), SUBTLEX (tác giả cho phép với điều kiện **ghi công các tác giả SUBTLEX** và nói rõ SUBTLEX là dữ liệu tự do), và dữ liệu Twitter. README cũng ghi dữ liệu là "ảnh chụp đến khoảng 2021", ít khả năng được cập nhật | `https://github.com/rspeer/wordfreq` (`README.md`, `LICENSE.txt`) |
| **Datamuse API** | Chỉ **ứng viên** từ đồng nghĩa / trái nghĩa (`rel_syn`, `rel_ant`) cho job nền; Haiku chọn, nên từ nào cuối cùng nằm trong mục từ còn do mô hình quyết định | Trang API ghi: nếu dùng API trong ứng dụng công khai, nhờ **ghi nhận Datamuse trong tài liệu của ứng dụng**. Từ 2027 phải có khóa (xem 4). Danh mục "Data sources" của trang liệt kê CMU Pronouncing Dictionary, Google Books Ngrams, word2vec, Paraphrase Database (XXL), WordNet 3.0, các từ điển trực tuyến do OneLook thu thập, định nghĩa từ WordNet và Wiktionary. **Điều khoản của các nguồn con này chưa đọc** | `https://www.datamuse.com/api/` |
| **Google Cloud Translation** (v2) | Bản dịch tiếng Việt của từ và của định nghĩa trong **bản tạm** của đường tra nhanh (mặc định `LOOKUP_FAST_TRANSLATOR=google`). Bản tạm không được ghi vào từ điển | `Service Terms` của Google Cloud, mục "Cloud Translation API": khách hàng phải theo *HTML Markup Requirements* và *attribution requirements*. Trang *Attribution Requirements* nêu: (1) khi hiển thị kết quả dịch từ Google Translate cho người dùng phải nói rõ đó là bản dịch tự động của Google Translate, bằng huy hiệu (badge) của Google đặt **ngay cạnh kết quả**, huy hiệu trên web phải liên kết tới `translate.google.com`; (2) mô tả ứng dụng và tài liệu trợ giúp phải nêu rằng Google Translate được dùng và có liên kết tới trang Cloud Translation; (3) nếu hiển thị kết quả **không chỉnh sửa**, phải đưa lời tuyên bố miễn trừ (disclaimer) mà trang quy định vào web hoặc app; (4) quy tắc đặt tên (không dùng "Google" hay "Google Translate" trong tên sản phẩm, không ngụ ý liên kết với Google) và không sửa dấu hiệu của Google; (5) nút kích hoạt dịch trên app di động nên ghi "Translate with Google". Trang cũng nói hướng dẫn thương hiệu có thể đổi không báo trước | `https://cloud.google.com/terms/service-terms` (mục 25); `https://docs.cloud.google.com/translate/attribution` |
| **Anthropic Claude** (Haiku 5.5) | Job nền: nghĩa tiếng Việt, định nghĩa, ví dụ, từ đồng / trái nghĩa đã chọn, từ nguyên... của mục từ tự tạo (đầu vào của mô hình gồm văn bản lấy từ Wiktionary và Free Dictionary). Đường tra nhanh chỉ dùng khi `LOOKUP_FAST_TRANSLATOR=haiku` | *Commercial Terms of Service* mục B: khách hàng giữ quyền với Inputs và sở hữu Outputs (Anthropic chuyển giao quyền, nếu có, cho khách hàng), và Anthropic không huấn luyện mô hình bằng Customer Content từ Services. Mục D.3: khách hàng phải **thông báo cho người dùng của mình** rằng các khẳng định về sự kiện trong Outputs không nên tin nếu chưa kiểm tra độc lập, vì có thể sai, thiếu hoặc gây hiểu lầm. **Chưa xác minh** tài khoản API đang dùng thuộc điều khoản nào (thương mại hay loại khác) | `https://www.anthropic.com/legal/commercial-terms` |

## 2. Ghi chú thêm về cách dữ liệu đi vào app

### 2.1 Free Dictionary

Bản tạm (`source = "translation"`) trả cho app các trường lấy từ Free Dictionary kèm trường `attribution` dựng từ `license` và `sourceUrls` của chính nó (`services/lookup/merge.ts`, `buildAttribution`). Với job nền, Free Dictionary chỉ được hỏi khi Wiktionary cục bộ không có dòng nào cho từ. Nghĩa là mục từ do job tạo có thể chứa nội dung đến từ Free Dictionary mà `admin_note` chỉ ghi "nguồn đã dùng" (không phải từng trường).

### 2.2 Wiktionary

Dữ liệu trong `ref_wiktionary_en` là bản **rút gọn** của dump (`docs/lookup-refdata.md` mục 6). Job đọc nó, gửi cho Haiku làm tư liệu, và mục từ do job tạo mang các trường ghép từ Wiktionary (IPA, audio, dạng biến, từ đồng nghĩa...) và từ Haiku (nghĩa tiếng Việt, tóm tắt...). Hiện **không có trường nào trong DB** ghi một giá trị cụ thể đến từ trang Wiktionary nào; chỉ có `admin_note` ghi tên nguồn đã dùng cho cả mục từ. Muốn ghi công theo từng mục từ (ví dụ liên kết `https://en.wiktionary.org/wiki/<từ>`) thì URL đó dựng được từ từ gốc, không cần lưu thêm.

### 2.3 wordfreq

Thư viện wordfreq (Python) chỉ chạy lúc xuất dữ liệu: `npm run refdata:wordfreq:export` ghi `data/refdata/wordfreq-en.tsv`, rồi `npm run refdata:wordfreq` nạp TSV vào bảng `ref_word_frequency`; sau đó ứng dụng chỉ đọc bảng trong DB. README của wordfreq có một mục FAQ nói về việc chuyển dữ liệu sang **CSV**: câu trả lời là không, vì định dạng CSV không có chỗ cho thông tin ghi công và giấy phép. Tệp TSV của ta là một định dạng cùng loại. Đây là điểm cần bạn cân nhắc (mục 5).

### 2.4 Hiện trạng ghi công trong sản phẩm

| Nơi | Hiện trạng đã kiểm trong mã |
|---|---|
| API `source = "translation"` | `attribution[]` chỉ chứa Wiktionary-via-Free-Dictionary (tối đa 3 mục), và là mảng rỗng khi Free Dictionary không có dữ liệu. **Không có mục cho Google, Anthropic, Datamuse, wordfreq.** `providers[]` liệt kê `google_translate`, `free_dictionary_api`, `claude_haiku` (tùy trường hợp) |
| API `source = "dictionary"` (mục từ đã có) | Không có trường ghi công |
| App Flutter, popup tra từ (`wordygo/lib/features/ebook/widgets/word_lookup_popup.dart`) | Hiển thị một dòng chữ nhỏ: `Translated by Google` nếu có nhà cung cấp tên `google`, ngược lại `Auto-translated`. **Backend gửi `google_translate`, không phải `google`**, nên điều kiện không bao giờ đúng và dòng luôn là `Auto-translated`. App không đọc trường `attribution` |
| App Flutter, màn hình giới thiệu / giấy phép | Không thấy màn nào (không có `showAboutDialog`, `showLicensePage` hay mục tương tự trong `wordygo/lib`; màn cài đặt có ở `lib/features/profile/screens/settings_screen.dart`) |
| Âm thanh | Không lưu tác giả hay giấy phép của tệp âm thanh |

## 3. Đề xuất nơi hiển thị (để bạn chọn; chưa làm gì trong mã)

| # | Nơi | Nội dung | Phủ được | Chi phí / ghi chú |
|---|---|---|---|---|
| 1 | Màn **"Giới thiệu & nguồn dữ liệu"** trong Cài đặt (một lần, tĩnh) | Danh sách nguồn ở mục 1: tên, việc dùng, giấy phép, liên kết. Câu "Google Translate được dùng để dịch trong ứng dụng" kèm liên kết; lời nhắc nội dung do AI tạo có thể sai | Wiktionary, wordfreq, Datamuse (lời cảm ơn "trong tài liệu của ứng dụng"), Google (mô tả ứng dụng / trợ giúp), Anthropic (thông báo cho người dùng) | Chỉ cần màn Flutter mới, không đổi API |
| 2 | **Popup tra từ** (bản tạm) | Dùng `attribution[]` đã có để ghi "Wiktionary, CC BY-SA 3.0" kèm liên kết; thêm huy hiệu Google ngay cạnh `translation_vi` khi `providers` có `google_translate`; sửa so khớp `google` thành `google_translate` | Free Dictionary / Wiktionary, Google | Đổi Flutter nhỏ. Nếu giữ chữ thay huy hiệu thì chưa đúng mô tả của Google (cần huy hiệu) |
| 3 | **Màn chi tiết mục từ** (mục từ trong DB) | Một dòng chân trang "Dữ liệu từ Wiktionary (CC BY-SA 4.0 / GFDL) và AI" với liên kết `https://en.wiktionary.org/wiki/<từ>` | Wiktionary, Anthropic | Hiện API `source = "dictionary"` chưa có trường này; app có thể tự dựng liên kết, hoặc API thêm trường |
| 4 | **Nút phát âm thanh** | Chữ nhỏ "Âm thanh: <tác giả>, <giấy phép>, Wikimedia Commons" hoặc liên kết sang trang tệp trên Commons | Âm thanh | Cần lưu thêm tác giả / giấy phép khi nạp audio (đổi schema và đường ống), hoặc chỉ liên kết sang Commons (dựng từ tên tệp) |
| 5 | **Nhãn nội dung AI** trên mục từ do job tạo (`admin_note` bắt đầu `[auto]`) | "Nội dung do AI hỗ trợ, có thể chưa chính xác" | Anthropic (mục D.3) | API cần trả cờ cho app; trang duyệt P8 có thể bỏ nhãn sau khi người duyệt xác nhận |
| 6 | **Tài liệu phát hành** (README, mô tả trên cửa hàng, trợ giúp) | Một câu cho Datamuse; một câu và liên kết cho Google Translate; trích dẫn wordfreq / Wiktextract nếu viết báo cáo học thuật | Datamuse, Google, wordfreq, kaikki | Không đổi mã |

Khuyến nghị tối thiểu của tôi (chỉ là gợi ý, bạn quyết): #1 và #2 vì chúng rẻ và phủ phần lớn các điều đã đọc; #5 nếu bạn công khai nội dung do job tạo mà không qua duyệt.

## 4. Mốc thời gian cần theo dõi

* **Datamuse yêu cầu khóa API**: phần đầu trang nói từ **1/2/2027**, mục *Usage limits* của chính trang đó nói **1/1/2027** (mâu thuẫn tại thời điểm đọc). Mã dùng ngày an toàn hơn, 1/1/2027, để cảnh báo. Chi tiết: `docs/lookup-runbook.md` mục 11.2.
* **Google Cloud Translation**: Google nói hướng dẫn thương hiệu có thể đổi không báo trước; kiểm tra lại trang *Attribution Requirements* mỗi lần phát hành.

## 5. Điều cần bạn quyết hoặc xác minh (chưa kết luận)

1. **Google Translate**: bản tạm hiện hiển thị `translation_vi` gần như nguyên văn (có chuẩn hóa nhẹ). App có coi đó là kết quả "không chỉnh sửa" để áp dụng lời tuyên bố miễn trừ không? Và huy hiệu của Google có được đặt cạnh kết quả không? Hiện chưa (mục 2.4).
2. **Nội dung sinh ra từ văn bản Wiktionary** (CC BY-SA / GFDL, điều kiện chia sẻ tương tự): mục từ do Haiku dựng từ tư liệu Wiktionary có phải chịu điều kiện ấy không, và nếu có thì hiển thị / công bố giấy phép nào cho dữ liệu từ điển của WordyGo? Tôi chưa có căn cứ để trả lời; cần ý kiến chuyên môn.
3. **Tệp TSV của wordfreq**: có vấn đề với mục FAQ về CSV của README không, và chỉ lưu hạng / điểm tần suất (không lưu văn bản của nguồn nào) thì có đổi gì không?
4. **Âm thanh Commons**: các tệp CC BY-SA yêu cầu ghi tác giả; app phát thẳng URL mà không hiển thị tác giả. Chọn phương án #4 nào (liên kết, hay lưu thêm tác giả)?
5. **Free Dictionary**: dịch vụ không có điều khoản đọc được. Có chấp nhận dùng nó trong sản phẩm phát hành khi chưa có điều khoản không? (Job nền ưu tiên Wiktionary cục bộ nên có thể bỏ Free Dictionary khỏi đường làm giàu, chỉ giữ ở đường tra nhanh.)
6. **Anthropic**: xác nhận tài khoản API thuộc điều khoản thương mại (mục B, D.3 đọc ở trên) và quyết định cách thông báo cho người dùng (#1 và #5 ở mục 3).
7. **Datamuse**: xin khóa, và quyết định có ghi nhận trong tài liệu ứng dụng (#6) không.

## 6. Điều chưa xác minh (tổng hợp)

* Điều khoản sử dụng (nếu có) của Free Dictionary API; giới hạn thật của nó.
* Giấy phép của các nguồn con của Datamuse (WordNet, Paraphrase Database, Google Books Ngrams, CMU Pronouncing Dictionary...).
* Trang *HTML Markup Requirements* của Google (áp dụng cho web có chỉ mục tìm kiếm; app di động có thể không liên quan, nhưng chưa đọc).
* Giấy phép của từng tệp âm thanh ngoài 5 tệp đã tra; giấy phép của từng bản ghi dữ liệu khác trong dump Wiktextract (dump gồm nhiều ngôn ngữ; ta chỉ giữ tiếng Anh, nhưng không kiểm từng bản ghi).
* Tài khoản Anthropic đang dùng thuộc điều khoản nào.
* Ngày đổi điều khoản của mọi trang trên sau 15/10/2026.
