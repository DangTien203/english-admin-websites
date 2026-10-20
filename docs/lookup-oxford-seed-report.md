# Báo cáo nạp Oxford 5000

Đợt nạp các từ của danh sách Oxford 5000 chưa có trong từ điển, qua đường ống làm giàu P6. Cách chạy: `docs/lookup-runbook.md` mục 13. Oxford chỉ cung cấp danh sách từ, loại từ và mức CEFR; nội dung do đường ống tự viết.

<!-- BEGIN GENERATED (npm run enrich:seed-oxford -- --report) -->

Sinh lúc 2026-10-20T06:29:58.918Z bởi `npm run enrich:seed-oxford -- --file … --report`. Phần này được ghi lại mỗi lần chạy; ghi chú viết tay nằm SAU dấu kết thúc và được giữ.

## 1. Dữ liệu vào và các lần gửi

File `oxford_5000.json`: 5,948 dòng, 4,958 từ khác nhau (chữ thường). Gộp 990 dòng trùng của 883 từ; 343 từ có nhiều mức CEFR (lấy mức thấp nhất); 5 dòng không có mức hợp lệ. Chỉ đọc từ, loại từ, mức CEFR; định nghĩa và ví dụ của Oxford không được dùng.

Độ phủ IPA/audio của file (từ hợp lệ, chỉ đếm, KHÔNG đưa vào mục từ): IPA 4,947/4,949 · audio US 4,949/4,949 · audio UK 4,949/4,949.

| # | bắt đầu (UTC) | kết thúc | cách chọn | từ đã gửi | dừng bởi | model | policy | đồng thời |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-10-20 05:58:04 | 05:58:33 | mẫu 50 | 50 | - | claude-haiku-5-5 | review | 2 |

## 2. Kết quả theo trạng thái và lý do

| status / reason | số từ |
|---|---|
| succeeded / - | 47 |
| failed / invalid_output | 2 |
| skipped / variant_form | 1 |

Tổng 50 từ đã gửi. Job còn `queued`/`running`: 0.

Tiêu chí dừng khẩn cấp ở giai đoạn 2 và 3: `invalid_output` 4.0% (2/50; dừng khi vượt 5%) đạt · job hết ngân sách hoặc lỗi nhà cung cấp (`budget`, `upstream_error`, `dead_letter`): 0 (dừng khi có quá 3 lần liên tiếp) · chi phí so với ước tính: mục 4 (dừng khi vượt 2 lần).

## 3. Từ bị bỏ qua

**Bị bộ làm sạch đầu vào từ chối (9):** `according to` (nhiều từ), `all right` (nhiều từ), `any more` (nhiều từ), `have to` (nhiều từ), `ice cream` (nhiều từ), `next to` (nhiều từ), `no one` (nhiều từ), `per cent` (nhiều từ), `used to` (nhiều từ)

**Không gửi vì đã có (tính tại thời điểm sinh báo cáo, nên gồm cả mục từ do chính đợt nạp này tạo):** trong từ điển 884 · là dạng biến trong word_forms 7 · đang trong hàng đợi 0 · đã có kết quả cuối từ job trước 3.

**Đã gửi nhưng không thành mục từ mới (3):**

| từ | status | reason | số lần chạy |
|---|---|---|---|
| into | failed | invalid_output | 1 |
| ought | skipped | variant_form | 1 |
| theirs | failed | invalid_output | 1 |

## 4. Token và chi phí: thực so với ước tính

| nguồn | token vào | token ra | chi phí ước tính | ghi chú |
|---|---|---|---|---|
| hàng word_enrichment_jobs của các từ đã gửi | 481,333 | 66,235 | $0.0466 | 49 job có gọi Haiku; chỉ lưu token của lần chạy cuối của mỗi job |
| bộ đếm api_usage_counters, mức tăng từ trước lần gửi đầu | 500,669 | 69,592 | $0.0502 | MỌI lần gọi Haiku trong thời gian đó, kể cả lần thử lại (và việc khác dùng Haiku cùng lúc, nếu có) |
| ước tính trước khi gửi (dry-run) | - | - | $0.0426 | 50 từ; nguồn: history |

Lần thử lại và lần gọi bị mất ở hàng sổ làm chênh lệch: bộ đếm cao hơn hàng sổ $0.0036. Chi phí thực tính cả lần thử lại: **$0.0502** ($0.0010 mỗi job có gọi Haiku). Bảng giá là nhập tay (`services/enrichment/pricing.ts`) và giả định 7,859 token system prompt đọc từ cache mỗi job: hóa đơn của Anthropic mới là số chính xác.

Chi phí thực bằng 1.18 lần ước tính (dừng khẩn cấp khi vượt 2 lần) — đạt.

Số lần chạy mỗi từ: trung bình 1.00 (theo hàng sổ); phân bố 1 lần: 50.

## 5. Thời gian

Từ lúc bắt đầu gửi đến job xong cuối cùng: 4 phút cho 50 từ.
Từ lúc job được tạo đến lúc xong (gồm thời gian chờ trong hàng đợi): trung vị 130.3 giây, p95 229.4 giây.

Theo log của worker (`oxford-seed-phase1-worker.log`, 50 dòng `enrich`): thời gian chạy MỘT job trung vị 8.6 giây, p95 17.8 giây, lâu nhất 25.3 giây; lần gọi Haiku trung bình 7.7 giây; dòng `enrich_retry`: 0; theo lần chạy lần 1: 50.

## 6. Phân bố CEFR: Oxford so với Haiku

```
Haiku (hàng) so với Oxford (cột), 47 mục từ có mức Oxford:
            A1   A2   B1   B2   C1   tổng
  A1         5    0    0    0    0      5
  A2         3    1    0    1    0      5
  B1         1    6    4    1    0     12
  B2         0    3    4    8    4     19
  C1         0    0    0    0    6      6
  trùng 24 (51%) · lệch 1 bậc 18 · lệch từ 2 bậc 5 · Haiku không đề xuất 0
  Haiku khó hơn Oxford 17 · dễ hơn 6
```

Mức CEFR đã được áp theo Oxford (`npm run oxford:apply-cefr`) cho 0/47 mục từ; phần còn lại vẫn mang mức Haiku ước tính. Cột "Haiku" của mục đã áp được đọc lại từ `entry_edit_history`.

## 7. Phân bố chủ đề

| chủ đề | số mục từ |
|---|---|
| core_language | 27 |
| business_economy | 6 |
| arts_entertainment | 5 |
| character_values | 4 |
| time_calendar | 4 |
| emotions_feelings | 3 |
| geography_places | 3 |
| media_communication | 3 |
| politics_law | 3 |
| psychology_mind | 3 |
| greetings_social | 2 |
| science_research | 2 |
| shopping_commerce | 2 |
| technology_digital | 2 |
| animals_wildlife | 1 |
| environment_society | 1 |
| health_medicine | 1 |
| plants_nature | 1 |
| sports_recreation | 1 |
| transport_travel | 1 |
| weather_climate | 1 |
| work_career | 1 |

47/47 mục từ có ít nhất một chủ đề; 0 mục không có chủ đề nào.

## 8. Mục thiếu IPA, audio, ví dụ; nghĩa và ghi chú

| chỉ tiêu | số mục từ | trên 47 |
|---|---|---|
| thiếu cả ipa_us và ipa_uk | 2 |  |
| thiếu ipa_us | 2 |  |
| thiếu cả audio_us_url và audio_uk_url | 4 |  |
| không có ví dụ nào | 0 |  |
| không có chủ đề | (mục 7) |  |
| đã xuất bản (published) | 0 |  |

Số nghĩa (sense) trung bình: 3.36; số nghĩa tiếng Việt (tách `definition_vi` bằng ";") trung bình: 7.13.

Mục từ có `notes_for_review` của Haiku: 47/47; trong đó 29 có ghi chú thuộc nhóm "cần xem" (chặn xuất bản hàng loạt). Theo nhóm: Nghĩa đã bỏ có chủ ý 53, CEFR ước tính 29, Thẻ đã bị bộ kiểm tra bỏ 22, Còn lại (không nhận ra) 15, Nghi ngờ nghĩa 13, Nghĩa gần nhau đã gộp 12, Ghi chú về dữ liệu nguồn 10, Bộ kiểm tra của job báo lỗi 9, Gợi ý biên tập 5, Lưu ý nhẹ về cách dùng 3, Giải thích điều đã giữ hay đã ghi 2, Tên riêng 1, Từ nhạy cảm hoặc thô tục 1.

## 9. Dung lượng cơ sở dữ liệu

|  | trước lần gửi đầu | bây giờ | tăng |
|---|---|---|---|
| toàn cơ sở dữ liệu (pg_database_size) | 251.10 MB | 251.27 MB | 0.16 MB |
| các bảng bị ghi (17, gồm chỉ mục và TOAST) | 6.07 MB | 6.16 MB | 0.09 MB |

Dung lượng trên đĩa gần như không đổi khi hàng mới dùng lại chỗ trống do các hàng đã xóa để lại (cơ sở dữ liệu vừa được dọn 38 mục từ), nên con số dưới đây mới là con số co giãn được: tổng kích thước DỮ LIỆU của các hàng thuộc những mục từ mới (chưa tính chỉ mục).

Dữ liệu của 47 mục từ mới: 0.21 MB (trung bình 4.6 KB mỗi mục từ). Với 4,055 từ còn có thể gửi, dự kiến thêm khoảng 18.16 MB dữ liệu, chưa tính chỉ mục. Theo bảng: dictionary_entries 72, sense_examples 42, entry_senses 42, sense_synonyms 14, entry_edit_history 12, entry_answer_aliases 9 (KB).

## 10. 30 từ ngẫu nhiên kèm nghĩa

| từ | loại từ | CEFR | nghĩa (meaning_vi) |
|---|---|---|---|
| within | preposition, adverb, adjective | B1 | bên trong; trong vòng; nêu trong văn bản này; trong phạm vi; trong thời hạn |
| talent | noun | B2 | tài năng; nhân tài; talăng; năng khiếu; người tài |
| fierce | adjective, adverb | B2 | dữ dội; quyết liệt; hung dữ; tuyệt vời; cực kỳ; hung tợn |
| presumably | adverb | C1 | có lẽ; chắc là; theo lẽ thường |
| proceeds | noun | B2 | tiền thu được; tiền lãi ròng; doanh thu; lợi nhuận; số tiền thu về; số tiền còn lại |
| neither | determiner, pronoun, conjunction, adverb | B1 | không cái nào; không ai trong hai; cũng không; không người nào; không cái nào trong hai |
| missile | noun | C1 | đạn; tên lửa; vật phóng; hỏa tiễn |
| fifty | number, noun | A1 | năm mươi; tờ năm mươi; 50; đồng năm mươi |
| while | noun, conjunction, verb | B1 | một lúc; trong khi; mặc dù; làm cho thời gian trôi qua; một khoảng thời gian; trong lúc |
| wow | exclamation, verb, noun | B1 | ồ; làm kinh ngạc; điều đáng kinh ngạc; chà; làm ngưỡng mộ; điều tuyệt vời |
| scale | noun, verb | B2 | thang đo; quy mô; vảy; cân; leo lên; mở rộng quy mô |
| via | preposition, noun | B2 | qua; lỗ xuyên; thông qua; bằng cách; via mạch in |
| formulate | verb | C1 | diễn đạt; trình bày rõ ràng; xây dựng |
| versus | preposition, verb | B2 | đối đầu với; kiện; đấu với; so với; thi đấu với |
| wherever | adverb, conjunction | B2 | rốt cuộc ở đâu; bất cứ đâu; bất cứ nơi nào; ở mọi nơi; ở đâu vậy; đâu cũng được |
| many | determiner, pronoun, noun, adjective | A1 | nhiều; bằng ngần này; nhiều người; số đông; rất nhiều; nhiều đến thế |
| left | adjective, adverb, noun, verb | A1 | trái; ngược chiều kim đồng hồ; sang trái; bên trái; đã rời đi; phía trái |
| whatever | pronoun, determiner, adverb, exclamation, adjective, noun | B1 | bất cứ điều gì; bất kỳ; chút nào; thôi kệ; tầm thường; cái gì đó |
| hopefully | adverb | B1 | đầy hy vọng; hy vọng rằng; lạc quan; mong là |
| upset | adjective, noun, verb | B2 | buồn bã; đau bụng; sự xáo trộn; sự thất bại bất ngờ; làm buồn lòng; làm xáo trộn |
| overly | adverb | C1 | quá mức; quá, lắm; quá đáng; đặc biệt |
| onto | preposition, adjective | B2 | lên trên; nhận ra; toàn ánh; tới trên; biết được |
| contain | verb | B2 | chứa; kiềm chế; đựng; bao gồm; kìm nén; hạn chế |
| yours | pronoun | A2 | của bạn; nhà bạn; trân trọng; của anh; nhà anh; thân ái |
| unless | conjunction | B1 | trừ khi; nếu không; trừ phi |
| genuine | adjective | B2 | thật; chân thành; nguyên gốc; chính hãng; thành thật; chính gốc |
| who | pronoun | A1 | ai; người mà; bất cứ ai; đội; người nào; người đã |
| recount | verb, noun | C1 | kể lại; đếm lại; sự đếm lại; thuật lại; kiểm đếm lại; cuộc kiểm đếm lại |
| heavily | adverb | B2 | nặng nề; rất nhiều; kiên cố; vạm vỡ; nặng nhọc; nặng trĩu |
| football | noun, verb | A2 | bóng đá; quả bóng đá; bóng bầu dục Mỹ; chơi bóng đá; môn bóng đá; quả bóng |

## 11. Mười mục từ đầy đủ nội dung (ngẫu nhiên)

### symbolic  _(adjective · B2 · chờ duyệt)_

- IPA: - / - · audio: có · `meaning_vi`: mang tính biểu tượng; mang tính tượng trưng; thuộc biểu tượng; chỉ mang ý nghĩa hình thức
- (adjective) Relating to or involving a symbol or symbols. → **mang tính biểu tượng; thuộc biểu tượng**
  - The dove is a symbolic representation of peace. — Chim bồ câu là biểu tượng tiêu biểu của hòa bình.
- (adjective) Done or said to represent something else, often without real practical effect. → **mang tính tượng trưng; chỉ mang ý nghĩa hình thức**
  - The minister made a symbolic visit to the flood area. — Bộ trưởng đến thăm khu vực lũ lụt mang tính hình thức.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: 2e8e0a9b-418b-4d89-873d-0bb9b26991ca · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · thiếu tầng B: ipa · ước tính: cefr_level=B2 · ghi chú của Haiku: Nghĩa thứ hai dựa trên định nghĩa Wiktionary 'implicitly representing or referring to another thing'; cần kiể

### whilst  _(conjunction, adverb · C1 · chờ duyệt)_

- IPA: /waɪlst/ / /waɪlst/ · audio: có · `meaning_vi`: trong khi; trong lúc đó; trong lúc; còn; trong khi đó
- (conjunction) During the time that something else is happening; at the same time as. → **trong khi; trong lúc; trong khi đó**
  - Drivers must switch off their engines whilst on stand. — Tài xế phải tắt động cơ trong khi xe đang đỗ.
  - She read the report whilst waiting for the train. — Cô ấy đọc báo cáo trong lúc chờ tàu.
- (conjunction) Used to contrast two facts or ideas; although or whereas. → **trong khi; còn**
  - He enjoys the city, whilst his brother prefers the countryside. — Anh ấy thích thành phố, còn anh trai thì thích vùng quê.
  - Whilst the plan sounds good, it is very expensive. — Dù kế hoạch nghe có vẻ tốt, nó lại rất tốn kém.
- (adverb) For a short period of time in the meantime; meanwhile. → **trong lúc đó; trong khi đó**
  - Go and tell the duke, and whilst I close her eyes. — Hãy đi báo cho công tước, còn ta sẽ khép mắt nàng lại.
  - Fetch the wine, and I will call the others in the whilst. — Hãy mang rượu đến, còn tôi sẽ gọi những người kia trong lúc đó.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, haiku · model: claude-haiku-5-5 · job: ec91ebb5-9087-4664-a9c9-24348e23740f · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=C1 · ghi chú của Haiku: Nghĩa 'besides/in addition' và 'provided that' xuất hiện trong dữ liệu nhưng rất hiếm và cổ, nên đã bỏ. | Nghĩa adverb 'meanwhile' gần như chỉ còn trong văn cổ; cân nh

### missile  _(noun · C1 · chờ duyệt)_

- IPA: /ˈmɪs.(ə)l/ / /ˈmɪs.aɪl/ · audio: có · `meaning_vi`: đạn; tên lửa; vật phóng; hỏa tiễn
- (noun) An object, such as a stone, arrow or bullet, that is thrown or fired through the air as a weapon. → **đạn; vật phóng**
  - The soldiers hurled missiles at the approaching enemy. — Binh lính ném đạn về phía kẻ thù đang tiến đến.
- (noun) A self-propelled weapon whose flight path can be adjusted after it has been launched. → **tên lửa; hỏa tiễn**
  - That missile is powerful enough to destroy an entire city block. — Quả tên lửa đó đủ sức phá hủy cả một khu phố.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: 149e2d9d-01ad-4822-8b89-e08a60de0b43 · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=C1 · ghi chú của Haiku: Nghĩa thứ nhất là nghĩa cổ, có thể cần cân nhắc khi biên tập. | Ước tính CEFR C1 dựa trên zipf 4.14 và rank 5712; cần kiểm tra lạ

### until  _(preposition, conjunction · A2 · chờ duyệt)_

- IPA: /ʌnˈtɪl/ / /ʌnˈtɪl/ · audio: có · `meaning_vi`: cho đến khi; đến tận; cho đến; đến lúc
- (preposition) Up to the time when something happens, or before a particular time or event. → **cho đến khi; đến tận**
  - If you can wait until after my meeting with her, we'll talk then. — Nếu bạn có thể đợi đến sau cuộc họp của tôi với cô ấy, chúng ta sẽ nói chuyện khi đó.
  - He didn't achieve fame until some time after he left New York. — Anh ấy mãi đến một thời gian sau khi rời New York mới nổi tiếng.
- (preposition) As far as a particular place; up to a certain point in space. → **đến tận; cho đến**
  - Keep walking until the second set of traffic lights, then turn left. — Cứ đi thẳng đến cột đèn giao thông thứ hai, rồi rẽ trái.
- (conjunction) Up to the time that something becomes true; used to say how long a situation continues. → **cho đến khi; đến lúc**
  - Not until I got his email did I fully understand his disappointment. — Mãi đến khi nhận được email của anh ấy, tôi mới hiểu hết sự thất vọng của anh ấy.
  - We waited until the rain stopped before going outside. — Chúng tôi đợi cho đến khi mưa tạnh rồi mới ra ngoài.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, haiku · model: claude-haiku-5-5 · job: 154062c0-479c-4c22-8a54-f12534f4aff5 · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=A2 · ghi chú của Haiku: Nghĩa 'trước khi' (before) và nghĩa lỗi thời 'hướng tới' không được đưa vào; nghĩa lỗi thời đã bỏ. | Nghĩa 'trước một thời điểm' gộp vào nghĩa 'cho đến khi' vì tiếng V

### hopefully  _(adverb · B1 · chờ duyệt)_

- IPA: /ˈhoʊp.fə.li/ / /ˈhəʊp.fə.li/ · audio: có · `meaning_vi`: đầy hy vọng; hy vọng rằng; lạc quan; mong là
- (adverb) In a way that shows hope or optimism about something. → **đầy hy vọng; lạc quan**
  - She looked hopefully at the door, waiting for her friend to arrive. — Cô ấy nhìn cánh cửa đầy hy vọng, chờ bạn mình đến.
- (adverb) It is to be hoped that something will happen or is the case. → **hy vọng rằng; mong là**
  - Hopefully, the train will be on time this morning. — Hy vọng sáng nay tàu sẽ đến đúng giờ.
  - We have finished the report, and hopefully the manager will approve it. — Chúng tôi đã hoàn thành báo cáo và hy vọng quản lý sẽ phê duyệt.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: faf82317-9cdd-4909-b0b2-07e28772434a · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=B1 · ghi chú của Haiku: Nghĩa thứ hai (hy vọng rằng) được dùng như trạng từ câu; một số giáo viên có thể yêu cầu học viên tránh trong văn viết trang trọn

### formulate  _(verb · C1 · chờ duyệt)_

- IPA: /ˈfɔː(ɹ)mjʊleɪt/ / - · audio: có · `meaning_vi`: diễn đạt; trình bày rõ ràng; xây dựng
- (verb) To express or put something into a clear, precise form, such as a statement, plan or idea. → **diễn đạt; trình bày rõ ràng; xây dựng**
  - He failed to formulate his ideas more clearly. — Anh ấy đã không thể diễn đạt ý tưởng của mình rõ ràng hơn.
  - The committee formulated a new policy on recycling. — Ủy ban đã xây dựng một chính sách mới về tái chế.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: dd7f78ed-ca81-4879-beb5-c4839d11fca5 · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · thiếu tầng B: etymology · ước tính: cefr_level=C1 · [ipa-untagged] ipa_us lấy từ IPA đầu tiên không gắn thẻ giọng của Wiktionary, không rõ giọng · ghi chú của Haiku: Chỉ có m

### exactly  _(adverb, exclamation · B1 · chờ duyệt)_

- IPA: /ɪɡˈzæk(t).li/ / - · audio: có · `meaning_vi`: chính xác; thật sự; đúng vậy; đúng; đúng là; hoàn toàn đúng
- (adverb) Without any approximation; with complete accuracy and precision. → **chính xác; đúng; hoàn toàn đúng**
  - Measure exactly so we can be sure it is right. — Hãy đo thật chính xác để chúng ta chắc chắn là đúng.
  - The edge is not exactly straight. — Cạnh này không hoàn toàn thẳng.
- (adverb) Used to emphasize a point, often in negative sentences, meaning 'not really' or 'not particularly'. → **thật sự; đúng là; chính là**
  - He did it that way exactly to prove the point. — Anh ấy làm theo cách đó chính là để chứng minh quan điểm.
  - Personal hygiene isn't exactly at the top of the priority list. — Vệ sinh cá nhân không hẳn là ưu tiên hàng đầu.
- (exclamation) Used to show that you agree completely with what someone has just said. → **đúng vậy; chính xác**
  - So you're saying that we have only three days left? Yes, exactly! — Vậy ý bạn là chúng ta chỉ còn ba ngày à? Đúng vậy!
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: 66b3f787-087c-4f8b-bdcb-42b893b18b00 · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=B1 · [ipa-untagged] ipa_us lấy từ IPA đầu tiên không gắn thẻ giọng của Wiktionary, không rõ giọng · ghi chú của Haiku: Nghĩa nhấn mạnh (sense 2) có thể c

### neither  _(determiner, pronoun, conjunction, adverb · B1 · chờ duyệt)_

- IPA: /ˈnaɪ.ðɚ/ / /ˈnaɪ.ðə/ · audio: có · `meaning_vi`: không cái nào; không ai trong hai; cũng không; không người nào; không cái nào trong hai
- (determiner) Not one or the other of two people or things. → **không cái nào; không người nào**
  - Neither definition seems correct. — Cả hai định nghĩa đều có vẻ không đúng.
- (pronoun) Not either one of two people or things. → **không ai trong hai; không cái nào trong hai**
  - I've tried on both shirts, but neither fits properly. — Tôi đã thử cả hai áo, nhưng cái nào cũng không vừa.
- (conjunction) Used before the first of two alternatives that are both negative, followed by nor. → **cũng không**
  - Neither you nor I likes it. — Cả bạn lẫn tôi đều không thích điều đó.
- (adverb) Also not; used to agree with a negative statement just made. → **cũng không**
  - 'I don't want to go.' 'Neither do I.' — 'Tôi không muốn đi.' 'Tôi cũng không.'
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, haiku · model: claude-haiku-5-5 · job: b01381e5-5a9b-451d-93f9-0f79e570a546 · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=B1 · ghi chú của Haiku: Nghĩa conjunction 'nor' cổ (archaic) bị bỏ qua vì không còn phổ biến. | Nghĩa 'nor' trong sense adverb là ứng viên đồng nghĩa, không phải đồng nghĩa hoàn toàn. | Datam

### trillion  _(noun · B2 · chờ duyệt)_

- IPA: /ˈtɹɪljən/ / - · audio: có · `meaning_vi`: nghìn tỷ; vô số; một triệu tỷ; hàng triệu
- (noun) The number equal to a million million, written as 1 followed by twelve zeros. → **nghìn tỷ; một triệu tỷ**
  - The national debt has now passed thirty-four trillion dollars. — Khoản nợ quốc gia hiện đã vượt mức ba mươi tư nghìn tỷ đô la.
  - Scientists estimate there are about two trillion trees on Earth. — Các nhà khoa học ước tính trên Trái Đất có khoảng hai nghìn tỷ cây.
- (noun) An unspecified, very large number, used informally to mean a huge quantity. → **vô số; hàng triệu**
  - There were trillions of stars visible in the night sky. — Có vô số ngôi sao hiện ra trên bầu trời đêm.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: 6f60cc25-3947-49ef-9a40-df7e8b2d58eb · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=B2 · [ipa-untagged] ipa_us lấy từ IPA đầu tiên không gắn thẻ giọng của Wiktionary, không rõ giọng · loại từ của Wiktionary không có trong mục: number · g

### versus  _(preposition, verb · B2 · chờ duyệt)_

- IPA: /ˈvɝsəs/ / /ˈvɜːsəs/ · audio: có · `meaning_vi`: đối đầu với; kiện; đấu với; so với; thi đấu với
- (preposition) Used to show that two teams, players or options are opposed or being compared. → **đối đầu với; so với**
  - It is the Packers versus the Steelers in the Super Bowl. — Đó là trận đấu giữa Packers và Steelers tại Super Bowl.
  - Renting a flat versus buying one is a difficult decision. — Thuê nhà so với mua nhà là một quyết định khó khăn.
- (preposition) Used in a court case title to name the opposing party to a lawsuit. → **kiện**
  - Brown v. Board of Education of Topeka, Kans. — Brown kiện Hội đồng Giáo dục Topeka, Kansas.
- (verb) To compete against someone or something. → **đấu với; thi đấu với**
  - The champion will versus the challenger next month. — Nhà vô địch sẽ thi đấu với người thách đấu vào tháng tới.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, haiku · model: claude-haiku-5-5 · job: 4fa06706-da1a-4a2d-8fd9-16f917631516 · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=B2 · ghi chú của Haiku: Nghĩa 'so với' và 'đối đầu với' ở giới từ có thể gộp lại nhưng được tách vì ngữ cảnh dịch khác nhau. | Động từ 'to fight' trong dữ liệu nguồn chưa được đưa vào do trùn

## 12. Câu SQL để tự kiểm tra

```sql
-- Kết quả theo trạng thái và lý do của job gần nhất mỗi từ trong ngày (đổi khoảng thời gian cho đúng)
SELECT status, coalesce(reason, '-') AS reason, count(*) FROM word_enrichment_jobs
 WHERE created_at > now() - interval '1 day' GROUP BY 1, 2 ORDER BY 3 DESC;

-- Mục từ tự tạo: đã xuất bản và chưa
SELECT published, count(*) FROM dictionary_entries WHERE admin_note LIKE '[auto]%' GROUP BY 1;

-- Phân bố mức CEFR của mục từ tự tạo, và số mục đã lấy mức theo Oxford
SELECT cefr_level, count(*) AS tong, count(*) FILTER (WHERE admin_note LIKE '%[oxford-cefr]%') AS theo_oxford
  FROM dictionary_entries WHERE admin_note LIKE '[auto]%' GROUP BY 1 ORDER BY 1;

-- Phân bố chủ đề (chỉ 30 chủ đề chuẩn) của mục từ tự tạo
SELECT t.name, count(*) FROM entry_tags et JOIN tags t ON t.id = et.tag_id JOIN dictionary_entries e ON e.id = et.entry_id
 WHERE e.admin_note LIKE '[auto]%' GROUP BY 1 ORDER BY 2 DESC;

-- Mục từ tự tạo thiếu IPA, thiếu audio, không có ví dụ
SELECT count(*) FILTER (WHERE ipa_us IS NULL AND ipa_uk IS NULL) AS thieu_ipa,
       count(*) FILTER (WHERE audio_us_url IS NULL AND audio_uk_url IS NULL) AS thieu_audio,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM entry_senses s JOIN sense_examples x ON x.sense_id = s.id WHERE s.entry_id = e.id)) AS khong_vi_du
  FROM dictionary_entries e WHERE admin_note LIKE '[auto]%';

-- Số lần thử trung bình và phân bố
SELECT attempts, count(*) FROM word_enrichment_jobs WHERE status IN ('succeeded','rejected','skipped','failed') GROUP BY 1 ORDER BY 1;

-- Token Anthropic trong tháng (mọi lần gọi, kể cả lần thử lại) và job đã gửi theo ngày
SELECT period, unit, used FROM api_usage_counters WHERE provider = 'anthropic' ORDER BY period DESC, unit;
SELECT period AS ngay, used AS job_da_gui FROM api_usage_counters WHERE provider = 'enrichment' AND unit = 'jobs' ORDER BY period DESC LIMIT 7;

-- Worker nào đang nối vào hàng đợi (chỉ được có worker của bạn khi đang nạp)
SELECT name, host, pid, started_on, heartbeat_on, stopped_on FROM pgboss.instance ORDER BY started_on DESC LIMIT 8;

-- Dung lượng cơ sở dữ liệu
SELECT pg_size_pretty(pg_database_size(current_database()));

-- Các mục từ đang chờ duyệt đủ điều kiện xuất bản hàng loạt: npm run enrich:publish   (chạy thử là mặc định)
```

<!-- END GENERATED -->
## Ghi chú các giai đoạn (viết tay)

### Giai đoạn 1: 50 từ phân tầng (20/10/2026)

* **Cách chạy.** `ENRICHMENT_ENABLED=true ENRICHMENT_PUBLISH_POLICY=review` đặt trong môi trường của cả lệnh gửi và worker (`.env` của dự án đang là `ENRICHMENT_ENABLED=false` và `ENRICHMENT_PUBLISH_POLICY=auto`, **không sửa**). Worker của máy này là worker duy nhất nối vào `pgboss.instance` lúc gửi. Mẫu: 10 từ mỗi mức A1, A2, B1, B2, C1, trộn loại từ. Worker được tắt (theo PID của chính tôi, sau khi hàng đợi trống) ngay khi 50 job xong.
* **Kết quả.** 47 mục từ mới (`succeeded`), tất cả `published = false`; 2 `failed / invalid_output` (`into`, `theirs`); 1 `skipped / variant_form` (`ought`). Không có 429, hết ngân sách, `upstream_error` hay thử lại: mọi job chạy đúng 1 lần.
* **Hai chỉ số dừng khẩn cấp của giai đoạn 2.** `invalid_output` là 4,0% (2/50), sát ngưỡng 5%: với 500 từ, 2 đến 3 lần lệch nhẹ đã vượt. Chi phí hàng sổ của 50 job là 0,0466 USD, bằng 1,09 lần ước tính 0,0426 USD (trung bình 0,00095 USD/job có gọi Haiku). Phần chênh giữa bộ đếm `api_usage_counters` và hàng sổ (19.336 token vào, 3.357 ra) **không phải lần thử lại**: đó là một lần chạy chẩn đoán `enrich:run -- --word into --dry-run` (2 lần gọi, khoảng 0,0022 USD) tôi chạy sau khi gửi để xem vì sao `into` hỏng; cộng vào thì bộ đếm là 1,18 lần ước tính. Cả hai dưới ngưỡng 2 lần.
* **`into` và `theirs`.** Bản nháp vẫn sai sau một lần sửa (`into` dùng 19.584 token vào, 3.838 token ra qua 2 lần gọi). Chạy lại `into` bằng `enrich:run --dry-run` thì đạt ở lần sửa (Haiku không tất định), nên đây là tỉ lệ ngẫu nhiên chứ không phải lỗi dữ liệu của riêng từ đó. Công cụ không gửi lại từ `invalid_output` một cách tự động.
* **`ought`.** `skipped / variant_form` là **dương tính giả** của quy tắc S2: mọi nghĩa của dòng trợ động từ trong Wiktionary mang thẻ `dialectal`/`formal`, nên cả từ bị coi là phi chuẩn và Haiku không được gọi. Không phải lỗi của công cụ nạp; cần tạo tay hoặc sửa quy tắc (chưa làm, ngoài phạm vi).
* **Ghi chú của Haiku.** 47/47 mục từ có `notes_for_review` (Haiku luôn ghi ít nhất ghi chú về mức CEFR ước tính), 29 mục có ghi chú thuộc nhóm "cần xem" nên **chưa đủ điều kiện xuất bản hàng loạt**; `npm run enrich:publish` (chạy thử) nói 20 mục đủ điều kiện trong tổng 50 mục `[auto]` chưa xuất bản (47 mới + 3 cũ: `batter`, `bolt`, `sage`). Chưa xuất bản mục nào.
* **Chất lượng nghĩa tiếng Việt cần người duyệt kỹ** (trong 30 từ mẫu): nghĩa hiếm hoặc sai ngữ cảnh vẫn lọt vào `meaning_vi`, ví dụ `talent` có "talăng" (một đơn vị tiền cổ), `wherever` có "rốt cuộc ở đâu", `onto` có "toàn ánh", `via` có "lỗ xuyên", `yours` có "trân trọng; thân ái" (lời kết thư). Có nghĩa dư ở cả từ chức năng (`who` có "đội", `onto` có "nhận ra"). Đây là lý do mục từ để `published = false`.
* **CEFR.** Haiku trùng Oxford ở 24/47 (51%), lệch 1 bậc 18, lệch 2 bậc trở lên 5; Haiku khó hơn Oxford 17 mục, dễ hơn 6. Chưa áp `oxford:apply-cefr` (chỉ chạy thử: 23 mục đổi mức, 24 chỉ đánh dấu). Không có mục `[auto]` cũ nào nằm trong file Oxford.
* **Thời gian.** Gửi 50 job mất 29 giây. Worker (2 job song song) xong sau khoảng 4 phút; một job chạy trung vị 8,6 giây, p95 17,8 giây, lâu nhất 25,3 giây (gần toàn bộ là lần gọi Haiku, trung bình 7,7 giây). Ước tính 11 giây/từ theo trung vị thật là hơi cao.
* **Dung lượng.** Trên đĩa gần như không đổi (+0,01 MB) vì hàng mới dùng lại chỗ trống do 38 mục từ vừa bị dọn để lại. Dữ liệu thật của 47 mục từ mới là 0,21 MB (4,6 KB mỗi mục từ, chưa tính chỉ mục): với khoảng 4.055 từ còn lại, dự kiến thêm cỡ 18 MB dữ liệu cộng chỉ mục.
* **Độ phủ IPA / audio.** File Oxford có IPA cho 4.947/4.949 từ hợp lệ và audio cho cả hai giọng, nhưng **không được đưa vào** theo yêu cầu. Mục từ do đường ống tạo thiếu cả hai IPA ở 2/47 mục từ và thiếu cả hai audio ở 4/47 (nguồn là Wiktionary / Free Dictionary).
* **Hai điểm khác với mô tả ban đầu.** (1) File thật có dạng `{id, value:{word, type, level, phonetics, us, uk, examples}}`, không có `definition` và mức CEFR nằm ở `level` (không phải `cefr`); trình đọc nhận cả dạng thật lẫn dạng phẳng của `import-oxford.mjs`. (2) Hiện có 845 mục không phải `[auto]` (không phải 840) và 3 mục `[auto]` cũ, tổng 848.

**Dừng ở đây, chờ bạn xem trước khi chạy giai đoạn 2.**
