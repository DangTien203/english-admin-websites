# WordyGo · Mẫu bản nháp làm giàu từ điển (P6a): 12 từ để duyệt

Ngày chạy: 14/10/2026 · Model: `claude-haiku-5-5` (lấy từ ANTHROPIC_MODEL_ENRICH) · Lệnh: `npm run enrich:draft -- --word <w> --json` (ba từ cuối thêm `--force`) · Chạy một lần mỗi từ, **không ghi vào DB** (chỉ đọc `ref_*`, `tags`).
Dữ liệu thô: các tệp JSON do lệnh in ra (không lưu trong repo). Đây là bản nháp để bạn duyệt chất lượng tiếng Việt trước khi sang P6b.

> **Trạng thái các đề xuất ở mục 4 (cập nhật 15/10/2026, P6b):**
> 1. Tăng số sense gửi cho Haiku — **ĐÃ LÀM** (bạn chọn): từ có hơn 8 sense gửi 12 sense và ngân sách 4000 token (`haiku/user-message.ts`); Haiku vẫn viết tối đa 6 sense. `quarantine` (15 sense) vào 9.940 token đầu vào thay vì khoảng 8.500.
> 2. Viết 3 nghĩa mỗi sense — không làm (tăng nguy cơ độn nghĩa).
> 3. `academic_formal` — không làm (bạn không chọn); các chủ đề yếu sau khi bỏ nó vẫn còn (`serendipity`, `ephemeral` chỉ còn 1 chủ đề).
> 4. Duyệt tay tiếng Việt gượng — việc của bạn; các mục từ P6b ở `published = false` chờ duyệt (`npm run enrich:review`).
>
> Lỗi không bắt được bằng validator (nghĩa độn về ý, nghĩa trùng giữa các sense, nghĩa sai) vẫn là giới hạn đã biết; xem `docs/lookup-enrichment.md` mục 16.

## Tóm tắt

| Từ | Số sense | Sense có ≥ 2 nghĩa | Số nghĩa mỗi sense | Phải sửa lại | Token vào / ra | Chi phí ước tính | Thời gian Haiku |
|---|---|---|---|---|---|---|---|
| serendipity | 1 | 1 | 3 | không | 641 / 840 | $0.00056 | 5593 ms |
| ubiquitous | 1 | 1 | 2 | không | 561 / 666 | $0.00047 | 4063 ms |
| run | 5 | 5 | 2, 2, 2, 2, 2 | không | 1099 / 1348 | $0.00086 | 7767 ms |
| light | 5 | 5 | 2, 2, 2, 2, 2 | không | 1519 / 1533 | $0.00100 | 6808 ms |
| bank | 6 | 2 | 1, 1, 2, 1, 2, 1 | không | 1064 / 1389 | $0.00088 | 7062 ms |
| ephemeral | 4 | 4 | 3, 2, 2, 2 | không | 760 / 1834 | $0.00107 | 8128 ms |
| podcast | 3 | 3 | 2, 2, 2 | không | 653 / 1009 | $0.00065 | 5342 ms |
| quarantine | 2 | 2 | 2, 2 | không | 1317 / 1259 | $0.00084 | 6599 ms |
| karaoke | 3 | 2 | 2, 2, 1 | không | 645 / 907 | $0.00060 | 4713 ms |
| london (--force) | 0 | 0 | - | không | 809 / 173 | $0.00025 | 2852 ms |
| recieve (--force) | 0 | 0 | - | không | 222 / 195 | $0.00020 | 4022 ms |
| asdfghjk (--force) | 0 | 0 | - | không | 142 / 255 | $0.00022 | 3423 ms |

- **Sense có từ 2 nghĩa trở lên: 25 / 30** (83%). 9 từ có mục từ đầy đủ; 3 từ (London, recieve, asdfghjk) bị phân loại và không có nội dung.
- **Token**: tổng 9432 vào (không tính cache) + 94308 cache đọc, 11408 ra, 12 lần gọi; trung bình mỗi từ có mục từ đầy đủ: 918 token vào, 1198 token ra.
- **Chi phí ước tính** (bảng giá nhập tay ngày 14/10/2026, cần xác minh lại): tổng $0.00759; trung bình $0.00077 mỗi từ có mục từ đầy đủ (rẻ nhất $0.0002 cho từ bị loại, đắt nhất $0.0011). Không gồm phần ghi prompt cache (system prompt khoảng 7,9K token gồm cả schema, cỡ $0.001 khi cache nguội): nó đã được trả ở lần thăm dò ngay trước đó.
- Kiểm tra hậu kỳ (S4): 12/12 đạt ngay lần đầu, không từ nào cần thử lại.

## Đánh giá của tôi (người viết mã, chưa phải người bản ngữ duyệt từ điển)

### 1. Điều chạy tốt

- **Phân loại đúng cả 3 ca khó**: `London` → `is_proper_noun=true`; `recieve` → `variant_of=receive`; `asdfghjk` → `is_english_word=false`. Ba lời gọi này chỉ tốn $0.0002 mỗi lần vì Haiku trả về bản tối giản (không có nội dung).
- **Cờ nguồn đúng trên dữ liệu thật** (đã có test chỉ-đọc): `recieve` có `onlyVariantRows=true` (tag `misspelling` vẫn còn trong cột `data`, nên bước S2 của P6b dùng được); `London` có `onlyProperNounRows=true`; từ thường không bật cờ nào. Chạy riêng `ran` (không thuộc 12 từ, chỉ đọc DB): `onlyFormRows=true`, `expectedLemma=run`.
- **Đạt ngay lần đầu 12/12**: không cần thử lại; không có nghĩa nào quá 40 ký tự hoặc 6 âm tiết, không có ngoặc đơn, không có chữ Hán, Hàn, Nhật, không trùng nghĩa chính xác. `example_vi` tự nhiên, không phải bản sao `example_en`.
- **Nhiều nghĩa ngắn**: 25 trên 30 sense (83%) có từ 2 nghĩa trở lên. Nhưng hầu hết là đúng 2 nghĩa: chỉ 2 sense có 3 nghĩa, **không sense nào có 4**. Mục tiêu "2 đến 4" thực tế thành "thường 2".
- Chi phí và thời gian nhỏ: trung bình khoảng $0.0006 và 3 đến 8 giây cho một từ có mục từ đầy đủ; prompt caching hoạt động (hơn 7,8K token system prompt được đọc từ cache ở mọi lần gọi).

### 2. Lỗi và điểm yếu gặp phải (không phải lỗi nào cũng bị validator bắt)

| Loại | Ví dụ thật trong 12 từ | Validator bắt được? |
|---|---|---|
| **Nghĩa trùng ý (độn)** | `ubiquitous`: "có mặt khắp nơi · phổ biến khắp nơi"; `run` sense 1: "chạy · chạy nhanh"; `serendipity`: ba cách nói lại của cùng một ý ("may mắn tình cờ", "sự tình cờ thú vị", "điều may mắn bất ngờ"); `light` tính từ: "sáng · sáng sủa"; `quarantine` (động từ): "cách ly · đưa vào diện cách ly" | **Không** (cần hiểu nghĩa). Ước tính khoảng 7 đến 8 trên 30 sense có nghĩa thứ hai gần như thừa |
| Độn do thêm bớt từ đứng đầu | `podcast` sense 2: "một tập podcast · tập podcast"; (thăm dò ngoài mẫu) `cat`: "con mèo · mèo" | **Có** (luật "loại từ / hạn định từ" thêm trong lúc làm P6a: con, cái, chiếc, sự, việc, cuộc, nỗi, niềm, một, những, các). Với `cat` lần đầu Haiku vẫn độn, validator bắt, lần sửa cho ra một nghĩa. `podcast` được chạy TRƯỚC khi "một, những, các" được thêm vào luật, nên mẫu này vẫn còn lỗi |
| Lặp nghĩa giữa các sense | `ephemeral`: "phù du" nằm ở cả sense 1 và sense 2 | Không (chỉ so trong cùng sense) |
| Nghĩa sai hoặc gượng | `ephemeral` sense 3 (suối theo mùa): "tạm thời có nước" gượng, "theo mùa" mới đúng; `light` trạng từ (đi du lịch gọn nhẹ): "nhẹ nhàng" sai nghĩa, chỉ "gọn nhẹ" đúng; `bank` động từ (máy bay nghiêng cánh): "nghiêng người khi rẽ" sai đối tượng | Không |
| **Thiếu nghĩa quan trọng** | `run` không có "điều hành", "hoạt động / vận hành", "chảy", "ứng cử"; `light` thiếu "đèn" thành sense riêng, "nhóm lửa / thắp" chỉ có một dạng | Không. **Nguyên nhân là dữ liệu đầu vào**: `run` có 22 sense trong Wiktionary, `light` 43, `bank` 42, mà prompt chỉ nhận 6 sense đầu (theo yêu cầu `maxSenses: 6`, chia đều giữa các loại từ). Haiku chỉ lập nghĩa từ những gì thấy |
| Sense một nghĩa không có ghi chú lý do | `bank` có 4 sense một nghĩa, `karaoke` động từ một nghĩa; system prompt yêu cầu ghi lý do vào `notes_for_review` | Không |
| `topics` lệch | `light` → `time_calendar` (sai); (thăm dò) `cat` → `food_drink` (sai); `ubiquitous` → `technology_digital`, `ephemeral` → `science_research` (yếu) | Chỉ lọc tên lạ; không đánh giá độ hợp lý |
| `academic_formal` dùng sai | Haiku gán thêm `academic_formal` cho `serendipity`, `ubiquitous`, `ephemeral` (và `fair`, B1) bên cạnh chủ đề khác; validator **bỏ** nó (chỉ giữ khi là chủ đề duy nhất và trình độ C1/C2). Hậu quả: ba từ C1 trừu tượng này còn lại chủ đề yếu | Có (bỏ), nhưng kết quả sau khi bỏ chưa tốt |
| `definition_en` dùng lại chính từ | `light` (adj), `bank` (verb), `karaoke` (sense 2, 3) | Chỉ ghi chú `[kiểm tra]` vào notes, không từ chối |

### 3. Từ nào nhận diện đúng

- `London`: tên riêng (đúng). `recieve`: lỗi chính tả của `receive` (đúng). `asdfghjk`: không phải từ tiếng Anh (đúng).
- `asdfghjk`: **Free Dictionary hết thời gian chờ** (2 lần thử, 2,5 giây mỗi lần; đúng như P2 đã ghi: dịch vụ này treo / trả 522 với từ không tồn tại thay vì trả 404). Nên `noSourceRecognizesWord=false` ("chưa kết luận được"), chứ không phải `true`. Trong job thật, lỗi này sẽ làm pg-boss thử lại và cuối cùng ra `failed / upstream_error` thay vì `rejected / unknown_word` (xem mục "Việc cho P6b" trong báo cáo).

### 4. Đề xuất (chưa làm, cần bạn quyết)

1. **Tăng số sense gửi cho Haiku với từ nhiều nghĩa** (ví dụ `maxSenses` 10 đến 12 khi từ có hơn 8 sense): tốn thêm khoảng 1K đến 2K token vào mỗi từ, cỡ $0.0002; sửa được lỗ hổng "thiếu nghĩa" ở `run`, `light`, `bank`.
2. Nếu muốn nghĩa dày hơn "thường 2": nói rõ trong prompt "mỗi sense viết 3 nghĩa khi có thể" (nhưng sẽ tăng nguy cơ độn; luật chống độn mới chỉ bắt được dạng cơ học).
3. `academic_formal`: bảo Haiku chọn "hoặc chỉ academic_formal, hoặc các chủ đề lĩnh vực", hoặc đổi validator sang giữ `academic_formal` cho từ C1/C2 khi các chủ đề kia không có mô tả khớp.
4. Duyệt tay: tiếng Việt ở `ephemeral` sense 3, `light` trạng từ, `bank` động từ (nêu ở mục 2).

### 5. Giới hạn của đánh giá này

Tôi đánh giá nghĩa tiếng Việt bằng cách đọc và đối chiếu với `definition_en`, không phải biên tập viên từ điển. Mẫu chỉ có 12 từ và 30 sense; con số "83%" và "7 đến 8 sense độn" là ước lượng thô, không phải thống kê.

Thứ tự thay đổi so với lần chạy 12 từ: bốn lần gọi thăm dò (`temperature`, `cat` ×2, `fair`; tất cả ngoài 12 từ) đã dẫn tới các chỉnh sửa sau, và **tất cả đã có mặt khi 12 từ chạy**: prompt chống độn nghĩa, giới hạn 6 sense trong prompt, luật loại từ (con, cái, chiếc, sự, việc, cuộc, nỗi, niềm), luật `academic_formal`. **Chỉ một thay đổi đến sau**: thêm "một, những, các" vào luật loại từ, sau khi thấy lỗi ở `podcast`. Vì vậy mẫu `podcast` còn chứa lỗi mà code hiện tại sẽ bắt. Tôi **không chạy lại** 12 từ, theo yêu cầu "không lặp".

**Chi phí**: lần chạy 12 từ diễn ra khi prompt cache còn ấm (lần thăm dò `cat` ngay trước đó đã trả phần ghi cache, khoảng 7,9K token, cỡ $0.001), nên con số trên không gồm phần ghi cache. Nếu cache nguội (không có job nào trong 5 phút), lần gọi đầu tiên tốn thêm cỡ $0.001.

---

# Chi tiết từng từ

## serendipity

- **Cờ nguồn**: onlyFormRows=false, onlyVariantRows=false, onlyProperNounRows=false, noSourceRecognizesWord=false; expectedLemma=serendipity
- **Nguồn (S1)**: Wiktionary 1 dòng / 3 sense; tần suất zipf 2.74, rank 40016; Free Dictionary: skipped; Datamuse 0 đồng nghĩa, 0 trái nghĩa
- **Haiku (S3/S4)**: 1 lần gọi, token vào 641 + cache đọc 7859, token ra 840; ước tính $0.00056; 5593 ms; đạt ngay lần đầu
- **Phân loại**: is_english_word=true, is_proper_noun=false, variant_of=null
- **Mục từ**: headword `serendipity`, lemma `serendipity`, pos [noun], cefr_level C1, is_countable true, is_transitive null
- **topics**: psychology_mind

| # | pos | meanings_vi | definition_en | register / domain / region |
|---|---|---|---|---|
| 1 | noun | **may mắn tình cờ · sự tình cờ thú vị · điều may mắn bất ngờ** (3) | The occurrence of finding something valuable or pleasant by chance, when you were not looking for it. | formal |

1. ví dụ: The discovery of penicillin was a case of pure serendipity. / Việc phát hiện ra penicillin là một sự may mắn tình cờ thuần túy.<br>ví dụ: We met by serendipity at a small café in Paris. / Chúng tôi gặp nhau một cách tình cờ thú vị tại một quán cà phê nhỏ ở Paris.<br>đồng nghĩa: chance, luck, fortune, accident<br>trái nghĩa: misfortune, bad luck<br>ngữ pháp: Thường dùng ở dạng không đếm được; dạng số nhiều serendipities rất hiếm.<br>lưu ý: Mang sắc thái tích cực, nhấn mạnh yếu tố ngẫu nhiên kết hợp với sự nhạy bén để nhận ra giá trị.

- collocations: by serendipity

Ghi chú cho người duyệt (notes_for_review):
- Nguồn chỉ có một nghĩa chính; các nghĩa 'tình cờ' được gộp thành một sense vì đều chỉ cùng một cách hiểu.
- Datamuse không có ứng viên; synonyms và antonyms lấy từ Wiktionary, antonyms 'misfortune' và 'bad luck' là đề xuất bổ sung cần kiểm tra.
- cefr_level C1 là ước tính dựa trên zipf 2.74 và rank 40016, cần xem lại.
- [kiểm tra] bỏ academic_formal: chỉ dành cho từ trừu tượng trình độ C1 hoặc C2 không hợp chủ đề nào khác

---

## ubiquitous

- **Cờ nguồn**: onlyFormRows=false, onlyVariantRows=false, onlyProperNounRows=false, noSourceRecognizesWord=false; expectedLemma=ubiquitous
- **Nguồn (S1)**: Wiktionary 1 dòng / 3 sense; tần suất zipf 3.42, rank 16814; Free Dictionary: skipped; Datamuse 2 đồng nghĩa, 0 trái nghĩa
- **Haiku (S3/S4)**: 1 lần gọi, token vào 561 + cache đọc 7859, token ra 666; ước tính $0.00047; 4063 ms; đạt ngay lần đầu
- **Phân loại**: is_english_word=true, is_proper_noun=false, variant_of=null
- **Mục từ**: headword `ubiquitous`, lemma `ubiquitous`, pos [adjective], cefr_level C1, is_countable null, is_transitive null
- **topics**: technology_digital

| # | pos | meanings_vi | definition_en | register / domain / region |
|---|---|---|---|---|
| 1 | adjective | **có mặt khắp nơi · phổ biến khắp nơi** (2) | Being or seeming to be everywhere at the same time. | formal |

1. ví dụ: Smartphones have become ubiquitous in modern society. / Điện thoại thông minh đã trở nên phổ biến khắp nơi trong xã hội hiện đại.<br>ví dụ: The ubiquitous advertisements filled every corner of the city. / Những quảng cáo có mặt khắp nơi lấp đầy mọi góc phố.<br>đồng nghĩa: omnipresent, pervasive, widespread<br>trái nghĩa: rare, scarce<br>lưu ý: Thường dùng cho sự vật, hiện tượng hoặc khái niệm; không dùng để so sánh hơn hay kém.

Ghi chú cho người duyệt (notes_for_review):
- Wiktionary ghi nghĩa 'phổ biến' và 'có mặt khắp nơi' gần nhau; đã gộp thành một sense chính.
- Có thể bổ sung sense riêng về nghĩa 'xuất hiện đồng thời ở nhiều nơi' nếu cần, nhưng nghĩa này hiếm trong ngữ cảnh học tập.
- cefr_level C1 ước tính từ zipf 3.42 và rank 16814.
- [kiểm tra] bỏ academic_formal: chỉ dành cho từ trừu tượng trình độ C1 hoặc C2 không hợp chủ đề nào khác

---

## run

- **Cờ nguồn**: onlyFormRows=false, onlyVariantRows=false, onlyProperNounRows=false, noSourceRecognizesWord=false; expectedLemma=run
- **Nguồn (S1)**: Wiktionary 4 dòng / 22 sense; tần suất zipf 5.49, rank 309; Free Dictionary: skipped; Datamuse 20 đồng nghĩa, 3 trái nghĩa
- **Haiku (S3/S4)**: 1 lần gọi, token vào 1099 + cache đọc 7859, token ra 1348; ước tính $0.00086; 7767 ms; đạt ngay lần đầu
- **Phân loại**: is_english_word=true, is_proper_noun=false, variant_of=null
- **Mục từ**: headword `run`, lemma `run`, pos [verb, noun, adjective], cefr_level A1, is_countable true, is_transitive false
- **topics**: sports_recreation, health_medicine

| # | pos | meanings_vi | definition_en | register / domain / region |
|---|---|---|---|---|
| 1 | verb | **chạy · chạy nhanh** (2) | To move quickly on your feet, going faster than walking, by taking steps so that both feet are briefly off the ground. | - |
| 2 | verb | **vội vàng đi · chạy vội** (2) | To move or go somewhere quickly, usually in a hurry. | - |
| 3 | noun | **cuộc chạy · buổi chạy bộ** (2) | An act of moving quickly on foot, such as a session of jogging or exercise. | - |
| 4 | noun | **chuyến đi nhanh · việc vặt** (2) | A short trip made quickly to a place to do a particular task. | - |
| 5 | adjective | **chảy lỏng · nóng chảy** (2) | Melted, or in a liquid form, especially after being heated. | technical |

1. ví dụ: Run, and you might still catch the train! / Chạy đi, có khi vẫn kịp chuyến tàu đấy!<br>đồng nghĩa: gallop, sprint, dash<br>trái nghĩa: walk, stroll<br>ngữ pháp: Động từ nội động; dạng quá khứ bất quy tắc là ran, quá khứ phân từ là run.
2. ví dụ: I have been running all over the building looking for him. / Tôi đã chạy khắp tòa nhà để tìm anh ấy.<br>đồng nghĩa: hurry, rush<br>trái nghĩa: idle<br>ngữ pháp: Nội động từ; thường đi với giới từ chỉ hướng như to hoặc over.
3. ví dụ: I just got back from my morning run. / Tôi vừa chạy bộ buổi sáng về.<br>đồng nghĩa: jog, sprint<br>ngữ pháp: Danh từ đếm được.
4. ví dụ: I need to make a run to the store. / Tôi cần ghé cửa hàng một chuyến.<br>đồng nghĩa: errand, trip
5. ví dụ: Put some melted butter on the vegetables. / Rưới chút bơ chảy lên rau.<br>đồng nghĩa: melted, molten<br>trái nghĩa: solid<br>ngữ pháp: Tính từ, không dùng ở dạng so sánh; thường đứng trước danh từ.<br>lưu ý: Nghĩa này khá hiếm và mang tính kỹ thuật hoặc cổ.

Ghi chú cho người duyệt (notes_for_review):
- Nghĩa tính từ 'in liquid state' được viết lại từ dữ liệu nguồn và có thể hiếm; cân nhắc giữ hoặc bỏ.
- Dữ liệu nguồn không có cụm từ, phrasal verb hay collocation đáng tin nên để trống.
- Ước lượng CEFR A1 dựa trên tần suất cao và nghĩa cơ bản; có thể là A2 tùy cách đánh giá.

---

## light

- **Cờ nguồn**: onlyFormRows=false, onlyVariantRows=false, onlyProperNounRows=false, noSourceRecognizesWord=false; expectedLemma=light
- **Nguồn (S1)**: Wiktionary 10 dòng / 43 sense; tần suất zipf 5.33, rank 467; Free Dictionary: skipped; Datamuse 20 đồng nghĩa, 5 trái nghĩa
- **Haiku (S3/S4)**: 1 lần gọi, token vào 1519 + cache đọc 7859, token ra 1533; ước tính $0.00100; 6808 ms; đạt ngay lần đầu
- **Phân loại**: is_english_word=true, is_proper_noun=false, variant_of=null
- **Mục từ**: headword `light`, lemma `light`, pos [noun, verb, adjective, adverb], cefr_level A1, is_countable true, is_transitive true
- **topics**: colors_shapes, science_research, time_calendar

| # | pos | meanings_vi | definition_en | register / domain / region |
|---|---|---|---|---|
| 1 | noun | **ánh sáng · ánh đèn** (2) | Electromagnetic radiation that the human eye can see, which allows us to see things around us. | science |
| 2 | verb | **thắp · nhóm** (2) | To make something start burning, such as a fire or a candle. | - |
| 3 | adjective | **sáng · sáng sủa** (2) | Full of light; bright and clear, not dark. | - |
| 4 | adjective | **nhẹ · nhẹ nhàng** (2) | Not heavy; having little weight, easy to carry or lift. | - |
| 5 | adverb | **nhẹ nhàng · gọn nhẹ** (2) | With only a small amount of luggage or possessions. | informal |

1. ví dụ: The dining room gets a lot of light in the morning. / Phòng ăn nhận được rất nhiều ánh sáng vào buổi sáng.<br>ví dụ: She stood in the light of the lamp. / Cô ấy đứng dưới ánh đèn.<br>đồng nghĩa: luminance, radiation<br>trái nghĩa: darkness<br>ngữ pháp: Thường là danh từ không đếm được khi nói về ánh sáng nói chung.
2. ví dụ: We lit the fire to get some heat. / Chúng tôi nhóm lửa để lấy hơi ấm.<br>ví dụ: He lit a candle on the cake. / Anh ấy thắp một ngọn nến trên bánh.<br>đồng nghĩa: set<br>trái nghĩa: extinguish, put out<br>ngữ pháp: Động từ bất quy tắc: light, lit, lit.
3. ví dụ: The room is light when the sun shines through the window. / Căn phòng sáng sủa khi ánh nắng chiếu qua cửa sổ.<br>ví dụ: She painted the walls a light shade of blue. / Cô ấy sơn tường bằng một sắc xanh nhạt.<br>đồng nghĩa: bright, pale<br>trái nghĩa: dark, dim
4. ví dụ: She carried a light bag to school every day. / Ngày nào cô ấy cũng mang một chiếc cặp nhẹ đến trường.<br>ví dụ: This jacket is light enough to wear in summer. / Chiếc áo khoác này đủ nhẹ để mặc vào mùa hè.<br>đồng nghĩa: lightweight, gentle, delicate<br>trái nghĩa: heavy, weighty
5. ví dụ: I prefer to travel light. / Tôi thích đi du lịch gọn nhẹ.<br>ví dụ: They packed light for the weekend trip. / Họ thu xếp hành lý gọn nhẹ cho chuyến đi cuối tuần.<br>ngữ pháp: Thường gặp trong cụm travel light.

Ghi chú cho người duyệt (notes_for_review):
- Nghĩa danh từ 'a stone that is not thrown hard enough' là nghĩa hiếm, đã bỏ qua.
- Phần 'light' với nghĩa 'calorie thấp' (lite, low-calorie) được bỏ để giữ đơn giản.
- cefr_level A1 ước tính từ zipf cao và nghĩa phổ biến; cần xem lại.
- [kiểm tra] senses[2].definition_en dùng lại chính từ đang định nghĩa

---

## bank

- **Cờ nguồn**: onlyFormRows=false, onlyVariantRows=false, onlyProperNounRows=false, noSourceRecognizesWord=false; expectedLemma=bank
- **Nguồn (S1)**: Wiktionary 9 dòng / 42 sense; tần suất zipf 5.16, rank 705; Free Dictionary: skipped; Datamuse 13 đồng nghĩa, 6 trái nghĩa
- **Haiku (S3/S4)**: 1 lần gọi, token vào 1064 + cache đọc 7859, token ra 1389; ước tính $0.00088; 7062 ms; đạt ngay lần đầu
- **Phân loại**: is_english_word=true, is_proper_noun=false, variant_of=null
- **Mục từ**: headword `bank`, lemma `bank`, pos [noun, verb], cefr_level A2, is_countable true, is_transitive false
- **topics**: business_economy, shopping_commerce, geography_places

| # | pos | meanings_vi | definition_en | register / domain / region |
|---|---|---|---|---|
| 1 | noun | **ngân hàng** (1) | An institution where people can keep money, borrow money and handle financial matters. | finance |
| 2 | verb | **giao dịch với ngân hàng** (1) | To deal with a bank, or for a bank to provide financial services to a client. | finance |
| 3 | noun | **bờ sông · bờ hồ** (2) | The raised land along the edge of a river, lake or other watercourse. | - |
| 4 | verb | **nghiêng người khi rẽ** (1) | To tilt an aircraft or vehicle sideways in order to turn. | technical / aviation |
| 5 | noun | **dãy · hàng** (2) | A row or group of similar things arranged together. | - |
| 6 | verb | **xếp thành dãy** (1) | To arrange things in a row or in a group. | - |

1. ví dụ: I need to go to the bank to open an account. / Tôi cần đến ngân hàng để mở tài khoản.<br>đồng nghĩa: financial institution, savings bank
2. ví dụ: She has banked with the same company for twenty years. / Cô ấy đã giao dịch với cùng một công ty trong hai mươi năm.<br>ngữ pháp: Nội động từ; thường đi với "with".
3. ví dụ: We sat on the grassy bank and watched the boats go by. / Chúng tôi ngồi trên bờ cỏ và ngắm những chiếc thuyền trôi qua.<br>đồng nghĩa: shore, riverside
4. ví dụ: The pilot banked the plane gently to the left. / Phi công nghiêng máy bay nhẹ sang trái.<br>đồng nghĩa: tilt, lean<br>ngữ pháp: Nội động từ.
5. ví dụ: There is a bank of lights above the stage. / Có một dãy đèn phía trên sân khấu.<br>đồng nghĩa: row, line, panel
6. ví dụ: The workers banked the sandbags along the wall. / Công nhân xếp các bao cát thành dãy dọc theo bức tường.<br>đồng nghĩa: line up, arrange<br>ngữ pháp: Ngoại động từ.

Ghi chú cho người duyệt (notes_for_review):
- Nghĩa "bờ sông" và "nghiêng người khi rẽ" xếp theo mức phổ biến; cân nhắc có nên giữ nghĩa kỹ thuật "xếp thành dãy" cho người học A2.
- Ước lượng CEFR A2 dựa trên zipf 5.16 và rank 705.
- Không có dữ liệu thành ngữ hay cụm động từ đã được xác minh nên để trống.
- [kiểm tra] senses[1].definition_en dùng lại chính từ đang định nghĩa

---

## ephemeral

- **Cờ nguồn**: onlyFormRows=false, onlyVariantRows=false, onlyProperNounRows=false, noSourceRecognizesWord=false; expectedLemma=ephemeral
- **Nguồn (S1)**: Wiktionary 2 dòng / 4 sense; tần suất zipf 2.99, rank 29260; Free Dictionary: skipped; Datamuse 7 đồng nghĩa, 0 trái nghĩa
- **Haiku (S3/S4)**: 1 lần gọi, token vào 760 + cache đọc 7859, token ra 1834; ước tính $0.00107; 8128 ms; đạt ngay lần đầu
- **Phân loại**: is_english_word=true, is_proper_noun=false, variant_of=null
- **Mục từ**: headword `ephemeral`, lemma `ephemeral`, pos [adjective, noun], cefr_level C1, is_countable null, is_transitive null
- **topics**: science_research

| # | pos | meanings_vi | definition_en | register / domain / region |
|---|---|---|---|---|
| 1 | adjective | **thoáng qua · ngắn ngủi · phù du** (3) | Lasting for only a short period of time. | formal |
| 2 | adjective | **sống một ngày · phù du** (2) | Existing for only one day, as with some flowers, insects, or diseases. | technical / biology |
| 3 | adjective | **tạm thời có nước · theo mùa** (2) | Usually dry, but filling with water for brief periods after rain. | technical / geography |
| 4 | noun | **vật thoáng qua · vật phù du** (2) | Something that lasts only for a short period of time. | formal |

1. ví dụ: Fame in the entertainment industry is often ephemeral. / Danh tiếng trong ngành giải trí thường chỉ thoáng qua.<br>ví dụ: The happiness she felt was ephemeral and soon faded. / Niềm vui cô ấy cảm thấy chỉ ngắn ngủi rồi nhanh chóng tan biến.<br>đồng nghĩa: temporary, transitory, fleeting, evanescent, momentary, short-lived<br>trái nghĩa: permanent, eternal, everlasting, timeless<br>lưu ý: Thường dùng cho cảm xúc, thành công, danh tiếng hoặc xu hướng nhất thời.
2. ví dụ: Mayflies are ephemeral insects that live only a day as adults. / Phù du là loài côn trùng sống ngắn ngày, chỉ sống một ngày khi trưởng thành.<br>ví dụ: Some flowers are ephemeral, blooming and fading within a single day. / Một số loài hoa chỉ nở rồi tàn trong một ngày.<br>đồng nghĩa: short-lived, brief<br>trái nghĩa: perennial, lasting<br>lưu ý: Nghĩa sinh học, chỉ thời gian sống rất ngắn của sinh vật.
3. ví dụ: The ephemeral stream flows only after heavy rainfall. / Con suối theo mùa chỉ chảy sau những trận mưa lớn.<br>ví dụ: Ephemeral lakes form in the desert after a rare storm. / Các hồ tạm thời hình thành trong sa mạc sau một cơn bão hiếm hoi.<br>đồng nghĩa: intermittent, seasonal<br>trái nghĩa: permanent, perennial<br>lưu ý: Dùng trong địa lý, nói về sông, hồ hoặc suối chỉ có nước trong thời gian ngắn.
4. ví dụ: Trends in social media are often ephemerals that disappear quickly. / Các xu hướng trên mạng xã hội thường là những thứ thoáng qua và nhanh chóng biến mất.<br>ví dụ: Critics dismissed the show as one of many ephemerals. / Các nhà phê bình xem chương trình này chỉ là một trong nhiều thứ phù du.<br>đồng nghĩa: ephemeron<br>ngữ pháp: Danh từ đếm được, số nhiều là ephemerals.<br>lưu ý: Ít gặp; thường dùng trong văn viết trang trọng.

- collocations: ephemeral beauty; ephemeral nature

Ghi chú cho người duyệt (notes_for_review):
- Nghĩa thứ ba (suối, hồ theo mùa) lấy từ dữ liệu Wiktionary; cần kiểm tra lại cách dịch meanings_vi.
- Nghĩa sinh học (một ngày) được gắn domain biology, cần xác nhận.
- cefr_level C1 là ước tính từ tần suất (zipf 2.99), chưa chắc chắn.
- Synonym 'short-lived' và 'brief' của nghĩa sinh học được chọn từ danh sách Wiktionary, cần kiểm tra độ chính xác theo sense.
- [kiểm tra] bỏ academic_formal: chỉ dành cho từ trừu tượng trình độ C1 hoặc C2 không hợp chủ đề nào khác

---

## podcast

- **Cờ nguồn**: onlyFormRows=false, onlyVariantRows=false, onlyProperNounRows=false, noSourceRecognizesWord=false; expectedLemma=podcast
- **Nguồn (S1)**: Wiktionary 2 dòng / 4 sense; tần suất zipf 4.15, rank 5615; Free Dictionary: skipped; Datamuse 0 đồng nghĩa, 0 trái nghĩa
- **Haiku (S3/S4)**: 1 lần gọi, token vào 653 + cache đọc 7859, token ra 1009; ước tính $0.00065; 5342 ms; đạt ngay lần đầu
- **Phân loại**: is_english_word=true, is_proper_noun=false, variant_of=null
- **Mục từ**: headword `podcast`, lemma `podcast`, pos [noun, verb], cefr_level B2, is_countable true, is_transitive true
- **topics**: media_communication, technology_digital

| # | pos | meanings_vi | definition_en | register / domain / region |
|---|---|---|---|---|
| 1 | noun | **chương trình âm thanh · podcast** (2) | A regular audio programme that you can download from the internet and listen to on a computer or mobile phone. | technology |
| 2 | noun | **một tập podcast · tập podcast** (2) | A single episode of a regular audio programme delivered over the internet. | technology |
| 3 | verb | **làm podcast · phát hành podcast** (2) | To produce and distribute a regular audio programme over the internet for people to listen to. | technology |

1. ví dụ: Try listening to a mix of well-known podcasts. / Hãy thử nghe nhiều podcast nổi tiếng.<br>đồng nghĩa: blogcast<br>lưu ý: Dùng phổ biến trong đời sống hiện đại; thường gọi là 'podcast' giữ nguyên.
2. ví dụ: I listened to the latest episode of my favourite podcast on the train. / Tôi đã nghe tập mới nhất của podcast yêu thích trên tàu.
3. ví dụ: She has been podcasting about history for three years. / Cô ấy đã làm podcast về lịch sử suốt ba năm qua.<br>ngữ pháp: Ngoại động từ (transitive) khi có tân ngữ; nội động từ khi không có tân ngữ.

- collocations: listen to a podcast

Ghi chú cho người duyệt (notes_for_review):
- Wiktionary ghi 'podcasted' là dạng quá khứ phổ biến nhưng đôi khi bị coi là không chuẩn; đã giữ 'podcast' cho dạng quá khứ.
- Nghĩa 'tập podcast' là cách hiểu rộng trong Wiktionary, đã tách thành sense riêng.
- CEFR B2 được ước tính từ zipf 4.15 và rank 5615; cần kiểm tra lại.

---

## quarantine

- **Cờ nguồn**: onlyFormRows=false, onlyVariantRows=false, onlyProperNounRows=false, noSourceRecognizesWord=false; expectedLemma=quarantine
- **Nguồn (S1)**: Wiktionary 4 dòng / 15 sense; tần suất zipf 3.64, rank 12306; Free Dictionary: skipped; Datamuse 0 đồng nghĩa, 0 trái nghĩa
- **Haiku (S3/S4)**: 1 lần gọi, token vào 1317 + cache đọc 7859, token ra 1259; ước tính $0.00084; 6599 ms; đạt ngay lần đầu
- **Phân loại**: is_english_word=true, is_proper_noun=false, variant_of=null
- **Mục từ**: headword `quarantine`, lemma `quarantine`, pos [noun, verb], cefr_level B2, is_countable true, is_transitive true
- **topics**: health_medicine, environment_society

| # | pos | meanings_vi | definition_en | register / domain / region |
|---|---|---|---|---|
| 1 | noun | **sự cách ly · thời gian cách ly** (2) | A period of isolation during which people or animals who may carry a contagious disease are kept apart from others to stop it spreading. | formal / medical |
| 2 | verb | **cách ly · đưa vào diện cách ly** (2) | To place a person, animal or ship in isolation to prevent the spread of a contagious disease. | formal / medical |

1. ví dụ: The sailors were kept in quarantine for forty days before they were allowed ashore. / Các thủy thủ bị cách ly bốn mươi ngày trước khi được phép lên bờ.<br>ví dụ: Travellers arriving from abroad must spend two weeks in quarantine. / Du khách đến từ nước ngoài phải cách ly hai tuần.<br>đồng nghĩa: isolation, segregation<br>ngữ pháp: Thường dùng không mạo từ khi nói về tình trạng: in quarantine, under quarantine.<br>lưu ý: Dùng cho cả người và động vật; trong tiếng Anh hiện đại thường kéo dài khoảng 14 đến 40 ngày.
2. ví dụ: Officials quarantined the whole village after the outbreak was confirmed. / Nhà chức trách cách ly cả ngôi làng sau khi xác nhận ổ dịch.<br>ví dụ: The ship was quarantined at the port for three weeks. / Con tàu bị cách ly tại cảng trong ba tuần.<br>đồng nghĩa: isolate, segregate<br>trái nghĩa: release<br>ngữ pháp: Ngoại động từ: quarantine someone/something. Chia quarantined, quarantining.<br>lưu ý: Thường dùng ở thể bị động: be quarantined.

- collocations: under quarantine; break quarantine

Ghi chú cho người duyệt (notes_for_review):
- Nghĩa lịch sử về 40 ngày quả phụ ở nhà chồng đã bỏ vì quá cổ và hiếm.
- Tên riêng Quarantine (núi Cám Dỗ) và các biến thể cổ đã bỏ vì không thuộc phạm vi mục từ thông dụng.
- Phân loại CEFR B2 dựa trên tần suất thấp (zipf 3.64) nhưng nghĩa thông dụng khá chuyên biệt; cần xem lại.
- Datamuse không có ứng viên đồng nghĩa hay trái nghĩa; các từ đồng nghĩa được chọn từ Wiktionary và kiến thức chung.

---

## karaoke

- **Cờ nguồn**: onlyFormRows=false, onlyVariantRows=false, onlyProperNounRows=false, noSourceRecognizesWord=false; expectedLemma=karaoke
- **Nguồn (S1)**: Wiktionary 2 dòng / 5 sense; tần suất zipf 3.43, rank 16507; Free Dictionary: skipped; Datamuse 0 đồng nghĩa, 0 trái nghĩa
- **Haiku (S3/S4)**: 1 lần gọi, token vào 645 + cache đọc 7859, token ra 907; ước tính $0.00060; 4713 ms; đạt ngay lần đầu
- **Phân loại**: is_english_word=true, is_proper_noun=false, variant_of=null
- **Mục từ**: headword `karaoke`, lemma `karaoke`, pos [noun, verb], cefr_level B1, is_countable true, is_transitive null
- **topics**: arts_entertainment, sports_recreation

| # | pos | meanings_vi | definition_en | register / domain / region |
|---|---|---|---|---|
| 1 | noun | **karaoke · hát karaoke** (2) | A form of entertainment in which people sing popular songs along to recorded music, with the lyrics shown on a screen. | informal |
| 2 | noun | **buổi hát karaoke · quán karaoke** (2) | A single session of singing karaoke, or a place where karaoke is held. | informal |
| 3 | verb | **hát karaoke** (1) | To perform karaoke by singing along to recorded music. | informal |

1. ví dụ: We spent the evening doing karaoke with our friends. / Chúng tôi dành cả buổi tối hát karaoke cùng bạn bè.<br>ngữ pháp: Thường không đếm được khi nói về hình thức giải trí nói chung.
2. ví dụ: Let's book a karaoke for Saturday night. / Hãy đặt phòng karaoke cho tối thứ Bảy.<br>đồng nghĩa: noraebang<br>ngữ pháp: Dùng được với mạo từ và số nhiều (karaokes).
3. ví dụ: They karaoked until midnight. / Họ hát karaoke đến nửa đêm.<br>ngữ pháp: Nội động từ; không có tân ngữ trực tiếp.

Ghi chú cho người duyệt (notes_for_review):
- Nghĩa bài tập giãn cơ (exercise) trong dữ liệu Wiktionary đã bị bỏ qua vì rất hiếm gặp.
- Ước tính cefr_level B1 dựa trên zipf thấp và rank lớn; cần xem lại.
- Không có ứng viên đồng nghĩa hoặc trái nghĩa từ Datamuse.
- [kiểm tra] senses[1].definition_en dùng lại chính từ đang định nghĩa
- [kiểm tra] senses[2].definition_en dùng lại chính từ đang định nghĩa

---

## london (chạy thêm --force)

- **Cờ nguồn**: onlyFormRows=false, onlyVariantRows=false, onlyProperNounRows=true, noSourceRecognizesWord=false; expectedLemma=null
- **Nguồn (S1)**: Wiktionary 1 dòng / 8 sense; tần suất zipf 5.27, rank 543; Free Dictionary: skipped; Datamuse 3 đồng nghĩa, 0 trái nghĩa
- **Haiku (S3/S4)**: 1 lần gọi, token vào 809 + cache đọc 7859, token ra 173; ước tính $0.00025; 2852 ms; đạt ngay lần đầu
- **Phân loại**: is_english_word=true, is_proper_noun=true, variant_of=null
- **Mục từ**: headword `London`, lemma `london`, pos [], cefr_level null, is_countable null, is_transitive null
- **topics**: (rỗng)

Ghi chú cho người duyệt (notes_for_review):
- London là tên riêng (địa danh, thủ đô Vương quốc Anh) nên không lập nội dung mục từ theo quy tắc.

---

## recieve (chạy thêm --force)

- **Cờ nguồn**: onlyFormRows=false, onlyVariantRows=true, onlyProperNounRows=false, noSourceRecognizesWord=false; expectedLemma=null
- **Nguồn (S1)**: Wiktionary 1 dòng / 1 sense; tần suất zipf 2.75, rank 39518; Free Dictionary: skipped; Datamuse 0 đồng nghĩa, 0 trái nghĩa
- **Haiku (S3/S4)**: 1 lần gọi, token vào 222 + cache đọc 7859, token ra 195; ước tính $0.00020; 4022 ms; đạt ngay lần đầu
- **Phân loại**: is_english_word=true, is_proper_noun=false, variant_of=receive
- **Mục từ**: headword `recieve`, lemma `recieve`, pos [], cefr_level null, is_countable null, is_transitive null
- **topics**: (rỗng)

Ghi chú cho người duyệt (notes_for_review):
- Lỗi chính tả của "receive"; dạng chuẩn là "receive". Không lập nội dung chi tiết. Xem mục "receive" để tra nghĩa.

---

## asdfghjk (chạy thêm --force)

- **Cờ nguồn**: onlyFormRows=false, onlyVariantRows=false, onlyProperNounRows=false, noSourceRecognizesWord=false; expectedLemma=null
- **Nguồn (S1)**: Wiktionary 0 dòng / 0 sense; tần suất không có; Free Dictionary: error ([free_dictionary] timeout after 2500ms); Datamuse 0 đồng nghĩa, 0 trái nghĩa
- **Haiku (S3/S4)**: 1 lần gọi, token vào 142 + cache đọc 7859, token ra 255; ước tính $0.00022; 3423 ms; đạt ngay lần đầu
- **Phân loại**: is_english_word=false, is_proper_noun=false, variant_of=null
- **Mục từ**: headword `asdfghjk`, lemma `asdfghjk`, pos [], cefr_level null, is_countable null, is_transitive null
- **topics**: (rỗng)

Ghi chú cho người duyệt (notes_for_review):
- Từ "asdfghjk" không phải từ tiếng Anh; đây là chuỗi ký tự liền kề trên hàng phím (có thể là gõ thử hoặc lỗi nhập liệu). Không có dữ liệu Wiktionary, Free Dictionary hay Datamuse để đối chiếu nên không lập nội dung.

