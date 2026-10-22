# Báo cáo nạp Oxford 5000

Đợt nạp các từ của danh sách Oxford 5000 chưa có trong từ điển, qua đường ống làm giàu P6. Cách chạy: `docs/lookup-runbook.md` mục 13. Oxford chỉ cung cấp danh sách từ, loại từ và mức CEFR; nội dung do đường ống tự viết.

<!-- BEGIN GENERATED (npm run enrich:seed-oxford -- --report) -->

Sinh lúc 2026-10-20T09:13:45.555Z bởi `npm run enrich:seed-oxford -- --file … --report`. Phạm vi: các lần gửi #2 đến #3. Phần này được ghi lại mỗi lần chạy; ghi chú viết tay nằm SAU dấu kết thúc và được giữ.

## 1. Dữ liệu vào và các lần gửi

File `oxford_5000.json`: 5,948 dòng, 4,958 từ khác nhau (chữ thường). Gộp 990 dòng trùng của 883 từ; 343 từ có nhiều mức CEFR (lấy mức thấp nhất); 5 dòng không có mức hợp lệ. Chỉ đọc từ, loại từ, mức CEFR; định nghĩa và ví dụ của Oxford không được dùng.

Độ phủ IPA/audio của file (từ hợp lệ, chỉ đếm, KHÔNG đưa vào mục từ): IPA 4,947/4,949 · audio US 4,949/4,949 · audio UK 4,949/4,949.

| # | bắt đầu (UTC) | kết thúc | cách chọn | từ đã gửi | dừng bởi | model | policy | đồng thời |
|---|---|---|---|---|---|---|---|---|
| 2 | 2026-10-20 07:57:50 | 08:05:25 | limit 500 | 500 | - | claude-haiku-5-5 | review | 2 |
| 3 | 2026-10-20 09:06:04 | 09:06:31 | gửi lại từ lần trước | 27 | - | claude-haiku-5-5 | review | 2 |

## 2. Kết quả theo trạng thái và lý do

| status / reason | số từ |
|---|---|
| succeeded / - | 474 |
| skipped / exists | 15 |
| failed / invalid_output | 9 |
| rejected / proper_noun | 2 |

Tổng 500 từ đã gửi. Job còn `queued`/`running`: 0.

Job hết ngân sách hoặc lỗi nhà cung cấp (`budget`, `upstream_error`, `dead_letter`) ở job gần nhất của từ: 0.

**Theo từng lần gửi** (đếm HÀNG sổ do lần gửi đó tạo, nên hàng cũ của từ được gửi lại vẫn nằm ở lần gửi cũ của nó):

| status / reason | lần #2 (500 từ) | lần #3 (27 từ) |
|---|---|---|
| failed / invalid_output | 28 | 8 |
| rejected / proper_noun | 2 | 0 |
| skipped / exists | 15 | 0 |
| succeeded / - | 455 | 19 |

Tiêu chí dừng khẩn cấp: ở LƯỢT ĐẦU (lần #2, 500 từ) `invalid_output` là 28 (5.6%; dừng khi vượt 5% theo yêu cầu ban đầu, 8% ở giai đoạn 2); sau các lần gửi lại còn 9/500 từ hỏng (1.8%). Lỗi nhà cung cấp và chi phí: ở trên và mục 4.

**`invalid_output` theo nguyên nhân (validator) và loại từ, từng lần gửi**

*Lần #2* (500 từ): 28 job `invalid_output`.

Luật mà bản nháp CUỐI (sau một lần sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 24 |
| classifier_duplicate @ senses[].meanings_vi[] | 3 |
| parenthesis @ senses[].meanings_vi[] | 1 |

Luật mà câu trả lời ĐẦU TIÊN (trước khi sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 25 |
| classifier_duplicate @ senses[].meanings_vi[] | 3 |

Theo loại từ (loại từ của hàng có mức CEFR thấp nhất trong file Oxford):

| loại từ | từ đã gửi | từ hỏng | tỉ lệ |
|---|---|---|---|
| noun | 211 | 7 | 3.3% |
| adjective | 89 | 8 | 9.0% |
| verb | 74 | 4 | 5.4% |
| adverb | 52 | 3 | 5.8% |
| pronoun | 20 | 2 | 10.0% |
| determiner | 17 | 2 | 11.8% |
| number | 10 | 0 | 0.0% |
| preposition | 8 | 1 | 12.5% |
| exclamation | 6 | 1 | 16.7% |
| modal verb | 5 | 0 | 0.0% |
| conjunction | 4 | 0 | 0.0% |
| ordinal number | 2 | 0 | 0.0% |
| definite article | 1 | 0 | 0.0% |
| infinitive marker | 1 | 0 | 0.0% |

Token ra của các job hỏng: trung vị 4,340 (giới hạn `ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH` mặc định 4.000).

Từng từ:

| từ | loại từ (Oxford) | CEFR | luật vi phạm ở bản cuối |
|---|---|---|---|
| free | adjective, adverb, verb | A1 | schema_too_big @ senses |
| front | adjective, noun | A1 | schema_too_big @ senses |
| give | verb | A1 | schema_too_big @ senses |
| half | adverb, determiner, noun, pronoun | A1 | schema_too_big @ senses |
| help | noun, verb | A1 | schema_too_big @ senses |
| history | noun | A1 | schema_too_big @ senses |
| hope | noun, verb | A1 | classifier_duplicate @ senses[].meanings_vi[] |
| into | preposition | A1 | schema_too_big @ senses |
| language | noun | A1 | schema_too_big @ senses |
| let | verb | A1 | schema_too_big @ senses |
| local | adjective, noun | A1 | schema_too_big @ senses |
| model | noun, verb | A1 | schema_too_big @ senses |
| move | noun, verb | A1 | schema_too_big @ senses |
| near | adjective, adverb, preposition | A1 | schema_too_big @ senses |
| nothing | pronoun | A1 | schema_too_big @ senses |
| off | adverb, preposition | A1 | schema_too_big @ senses |
| open | adjective, verb | A1 | schema_too_big @ senses |
| out | adverb, preposition | A1 | schema_too_big @ senses |
| period | noun | A1 | schema_too_big @ senses |
| place | noun, verb | A1 | schema_too_big @ senses |
| right | adjective, adverb, noun | A1 | schema_too_big @ senses |
| slow | adjective, verb | A1 | parenthesis @ senses[].meanings_vi[] |
| sound | adjective, noun, verb | A1 | schema_too_big @ senses |
| still | adjective, adverb | A1 | schema_too_big @ senses |
| welcome | adjective, exclamation, noun, verb | A1 | schema_too_big @ senses |
| which | determiner, pronoun | A1 | classifier_duplicate @ senses[].meanings_vi[] |
| yes | exclamation | A1 | schema_too_big @ senses |
| you | pronoun | A1 | classifier_duplicate @ senses[].meanings_vi[] |

*Lần #3* (27 từ): 8 job `invalid_output`.

Luật mà bản nháp CUỐI (sau một lần sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 5 |
| classifier_duplicate @ senses[].meanings_vi[] | 3 |

Luật mà câu trả lời ĐẦU TIÊN (trước khi sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 6 |
| classifier_duplicate @ senses[].meanings_vi[] | 2 |

Theo loại từ (loại từ của hàng có mức CEFR thấp nhất trong file Oxford):

| loại từ | từ đã gửi | từ hỏng | tỉ lệ |
|---|---|---|---|
| adjective | 8 | 3 | 37.5% |
| noun | 7 | 1 | 14.3% |
| verb | 4 | 1 | 25.0% |
| adverb | 3 | 1 | 33.3% |
| pronoun | 2 | 1 | 50.0% |
| determiner | 2 | 1 | 50.0% |
| exclamation | 1 | 0 | 0.0% |

Token ra của các job hỏng: trung vị 3,956 (giới hạn `ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH` mặc định 4.000).

Từng từ:

| từ | loại từ (Oxford) | CEFR | luật vi phạm ở bản cuối |
|---|---|---|---|
| half | adverb, determiner, noun, pronoun | A1 | classifier_duplicate @ senses[].meanings_vi[] |
| help | noun, verb | A1 | schema_too_big @ senses |
| hope | noun, verb | A1 | classifier_duplicate @ senses[].meanings_vi[] |
| out | adverb, preposition | A1 | schema_too_big @ senses |
| right | adjective, adverb, noun | A1 | schema_too_big @ senses |
| slow | adjective, verb | A1 | schema_too_big @ senses |
| welcome | adjective, exclamation, noun, verb | A1 | schema_too_big @ senses |
| you | pronoun | A1 | classifier_duplicate @ senses[].meanings_vi[] |

## 3. Từ bị bỏ qua

**Bị bộ làm sạch đầu vào từ chối (9):** `according to` (nhiều từ), `all right` (nhiều từ), `any more` (nhiều từ), `have to` (nhiều từ), `ice cream` (nhiều từ), `next to` (nhiều từ), `no one` (nhiều từ), `per cent` (nhiều từ), `used to` (nhiều từ)

**Không gửi vì đã có (tính tại thời điểm sinh báo cáo, nên gồm cả mục từ do chính đợt nạp này tạo):** trong từ điển 1,358 · là dạng biến trong word_forms 82 · đang trong hàng đợi 0 · đã có kết quả cuối từ job trước 12.

**Đã gửi nhưng không thành mục từ mới (26), theo job gần nhất của từ:**

| từ | status | reason | số lần chạy |
|---|---|---|---|
| evening | skipped | exists | 1 |
| february | rejected | proper_noun | 1 |
| feeling | skipped | exists | 1 |
| half | failed | invalid_output | 1 |
| help | failed | invalid_output | 1 |
| his | skipped | exists | 1 |
| hope | failed | invalid_output | 1 |
| interested | skipped | exists | 1 |
| interesting | skipped | exists | 1 |
| into | failed | invalid_output | 1 |
| its | skipped | exists | 1 |
| july | rejected | proper_noun | 1 |
| meaning | skipped | exists | 1 |
| meeting | skipped | exists | 1 |
| my | skipped | exists | 1 |
| news | skipped | exists | 1 |
| our | skipped | exists | 1 |
| out | failed | invalid_output | 1 |
| reading | skipped | exists | 1 |
| right | failed | invalid_output | 1 |
| slow | failed | invalid_output | 1 |
| them | skipped | exists | 1 |
| they | skipped | exists | 1 |
| welcome | failed | invalid_output | 1 |
| would | skipped | exists | 1 |
| you | failed | invalid_output | 1 |

## 4. Token và chi phí: thực so với ước tính

| nguồn | token vào | token ra | chi phí ước tính | ghi chú |
|---|---|---|---|---|
| hàng word_enrichment_jobs của các từ đã gửi | 5,838,989 | 946,266 | $0.69 | 512 job có gọi Haiku; chỉ lưu token của lần chạy cuối của mỗi job |
| bộ đếm api_usage_counters, mức tăng từ trước lần gửi đầu | 5,848,203 | 948,084 | $0.70 | MỌI lần gọi Haiku trong thời gian đó, kể cả lần thử lại (và việc khác dùng Haiku cùng lúc, nếu có) |
| ước tính trước khi gửi (dry-run) | - | - | $0.48 | 527 từ; nguồn: history, history |

Lần thử lại và lần gọi bị mất ở hàng sổ làm chênh lệch: bộ đếm cao hơn hàng sổ $0.0018. Chi phí thực tính cả lần thử lại: **$0.70** ($0.0014 mỗi job có gọi Haiku). Bảng giá là nhập tay (`services/enrichment/pricing.ts`) và giả định 7,859 token system prompt đọc từ cache mỗi job: hóa đơn của Anthropic mới là số chính xác.

Chi phí thực bằng 1.44 lần ước tính (dừng khẩn cấp khi vượt 2 lần) — đạt.

Số lần chạy mỗi từ: trung bình 1.01 (theo hàng sổ); phân bố 1 lần: 497, 2 lần: 3.

## 5. Thời gian

Từ lúc bắt đầu gửi đến job xong cuối cùng: 72 phút cho 500 từ.
Từ lúc job được tạo đến lúc xong (gồm thời gian chờ trong hàng đợi): trung vị 1827.8 giây, p95 3439.0 giây.

Theo log của worker (`oxford-seed-phase2-worker.log`, 527 dòng `enrich`): thời gian chạy MỘT job trung vị 12.2 giây, p95 26.3 giây, lâu nhất 87.2 giây; lần gọi Haiku trung bình 9.9 giây; dòng `enrich_retry`: 2; theo lần chạy lần 1: 523, lần 2: 4.

## 6. Phân bố CEFR: Oxford so với Haiku

```
Haiku (hàng) so với Oxford (cột), 474 mục từ có mức Oxford:
            A1   tổng
  A1       221    221
  A2       178    178
  B1        70     70
  B2         5      5
  trùng 221 (47%) · lệch 1 bậc 178 · lệch từ 2 bậc 75 · Haiku không đề xuất 0
  Haiku khó hơn Oxford 253 · dễ hơn 0
```

Mức CEFR đã được áp theo Oxford (`npm run oxford:apply-cefr`) cho 0/474 mục từ; phần còn lại vẫn mang mức Haiku ước tính. Cột "Haiku" của mục đã áp được đọc lại từ `entry_edit_history`.

## 7. Phân bố chủ đề

| chủ đề | số mục từ |
|---|---|
| core_language | 283 |
| time_calendar | 94 |
| media_communication | 56 |
| geography_places | 40 |
| arts_entertainment | 38 |
| work_career | 38 |
| business_economy | 32 |
| greetings_social | 29 |
| education_school | 28 |
| transport_travel | 27 |
| family_relationships | 23 |
| politics_law | 21 |
| psychology_mind | 20 |
| sports_recreation | 20 |
| technology_digital | 20 |
| emotions_feelings | 19 |
| home_household | 18 |
| body_appearance | 16 |
| character_values | 16 |
| health_medicine | 16 |
| science_research | 16 |
| shopping_commerce | 16 |
| food_drink | 15 |
| weather_climate | 15 |
| plants_nature | 14 |
| colors_shapes | 11 |
| environment_society | 6 |
| animals_wildlife | 5 |
| clothes_fashion | 5 |

474/474 mục từ có ít nhất một chủ đề; 0 mục không có chủ đề nào.

## 8. Mục thiếu IPA, audio, ví dụ; nghĩa và ghi chú

| chỉ tiêu | số mục từ | trên 474 |
|---|---|---|
| thiếu cả ipa_us và ipa_uk | 2 |  |
| thiếu ipa_us | 23 |  |
| thiếu cả audio_us_url và audio_uk_url | 2 |  |
| không có ví dụ nào | 0 |  |
| không có chủ đề | (mục 7) |  |
| đã xuất bản (published) | 0 |  |

Số nghĩa (sense) trung bình: 4.45; số nghĩa tiếng Việt (tách `definition_vi` bằng ";") trung bình: 9.30.

Mục từ có `notes_for_review` của Haiku: 474/474; trong đó 294 có ghi chú thuộc nhóm "cần xem" (chặn xuất bản hàng loạt). Theo nhóm: Nghĩa đã bỏ có chủ ý 783, Bộ kiểm tra của job báo lỗi 223, CEFR ước tính 220, Nghi ngờ nghĩa 108, Còn lại (không nhận ra) 106, Thẻ đã bị bộ kiểm tra bỏ 93, Nghĩa gần nhau đã gộp 92, Ghi chú về dữ liệu nguồn 52, Gợi ý biên tập 46, Lưu ý nhẹ về cách dùng 42, Giải thích điều đã giữ hay đã ghi 29, Từ nhạy cảm hoặc thô tục 24, Tên riêng 8.

## 9. Dung lượng cơ sở dữ liệu

|  | trước lần gửi đầu | bây giờ | tăng |
|---|---|---|---|
| toàn cơ sở dữ liệu (pg_database_size) | 251.41 MB | 256.73 MB | 5.31 MB |
| các bảng bị ghi (17, gồm chỉ mục và TOAST) | 6.23 MB | 11.25 MB | 5.02 MB |

Dung lượng trên đĩa gần như không đổi khi hàng mới dùng lại chỗ trống do các hàng đã xóa để lại (cơ sở dữ liệu vừa được dọn 38 mục từ), nên con số dưới đây mới là con số co giãn được: tổng kích thước DỮ LIỆU của các hàng thuộc những mục từ mới (chưa tính chỉ mục).

Dữ liệu của 474 mục từ mới: 2.75 MB (trung bình 5.9 KB mỗi mục từ). Với 3,497 từ còn có thể gửi, dự kiến thêm khoảng 20.31 MB dữ liệu, chưa tính chỉ mục. Theo bảng: dictionary_entries 839, sense_examples 548, entry_senses 502, entry_answer_aliases 191, sense_synonyms 190, word_forms 173 (KB).

## 10. 30 từ ngẫu nhiên kèm nghĩa

| từ | loại từ | CEFR | nghĩa (meaning_vi) |
|---|---|---|---|
| October | noun | A1 | tháng mười |
| fourth | adjective, noun, verb | A2 | thứ tư; một phần tư; người thứ tư; tán thành sau người thứ ba; vật thứ tư |
| home | noun, adverb, adjective | A1 | nhà; quê hương; về nhà; trong nước; tổ ấm; quê nhà |
| he | pronoun, noun, exclamation | A1 | anh ấy; trò chơi đuổi bắt; ha ha; ông ấy; hi hi; cậu ấy |
| film | noun, verb | A2 | phim; cuộn phim; màng mỏng; quay phim; phủ màng; phim điện ảnh |
| yes | exclamation, noun, verb, determiner | A1 | vâng; tuyệt; lời đồng ý; phiếu thuận; đồng ý; có đấy |
| weekend | noun, verb, adjective | A1 | cuối tuần; nghỉ cuối tuần; ngày nghỉ cuối tuần; đi chơi cuối tuần; dành cho cuối tuần |
| someone | pronoun, noun | A2 | ai đó; người nào đó; nhân vật quan trọng; người đặc biệt; người có tiếng |
| difficult | adjective | B1 | khó; khó tính; không sẵn lòng; khó khăn; bướng bỉnh; hóc búa |
| wait | verb, noun, exclamation | A1 | chờ; phục vụ; sự chờ đợi; cuộc phục kích; khoan đã; đợi |
| remember | verb | A1 | nhớ lại; ghi nhớ; nhớ làm; để lại cho; gửi lời hỏi thăm; hồi tưởng |
| hate | noun, verb | B1 | sự căm ghét; lời lẽ thù ghét; ghét; căm ghét; công kích; nỗi ghét |
| glass | noun, verb | A2 | thủy tinh; ly; ly đầy; đồ thủy tinh; lắp kính; đập ly vào |
| everything | pronoun, noun | A2 | tất cả; mọi thứ; mọi việc ổn; bánh bagel tổng hợp; tất cả mọi thứ; tình trạng tốt |
| think | verb, noun | A1 | suy nghĩ; nghĩ rằng; hình dung; định; sự suy nghĩ; cân nhắc |
| ride | verb, noun | A2 | cưỡi; đi nhờ xe; lướt đi; chuyến đi; chuyến đi nhờ; trò chơi cảm giác mạnh |
| quickly | adverb | A2 | nhanh chóng; chẳng bao lâu; mau lẹ; ngay sau đó |
| probably | adverb | A2 | có lẽ; chắc là; hầu như chắc chắn |
| white | adjective, noun, verb | A1 | trắng; da trắng; màu trắng; người da trắng; bướm trắng; làm trắng |
| meet | verb, noun, adjective | A1 | gặp; họp; cuộc thi đấu; thích hợp; gặp gỡ; tụ họp |
| reason | noun, verb | A2 | lý do; lý trí; suy luận; tranh luận; nguyên nhân; cớ |
| young | adjective, noun, verb | A1 | trẻ; mới mẻ; con non; trẻ hóa; non trẻ; còn non trẻ |
| speak | verb, noun | A1 | nói; trò chuyện; phát biểu; biết nói; thể hiện; biệt ngữ |
| travel | verb, noun | A2 | đi du lịch; lan truyền; đi khắp; du lịch; các chuyến đi; đi lại |
| same | adjective, adverb, pronoun | A1 | giống nhau; tương tự; như nhau; điều tương tự; cùng một; giống như |
| island | noun, verb | A2 | hòn đảo; ốc đảo; cô lập bằng nước; đảo; điểm khác biệt; biến thành đảo |
| radio | noun, verb | A2 | sóng vô tuyến; máy thu thanh; gọi bằng bộ đàm; vô tuyến; radio; truyền tin qua vô tuyến |
| two | number, noun | A1 | hai; chữ số 2; hai giờ; số hai; số 2 |
| father | noun, verb | A1 | cha; tổ tiên; ông; làm cha; nuôi dưỡng; bố |
| explain | verb | B1 | giải thích; lý giải; thanh minh; làm rõ; giải thích nguyên nhân; biện minh |

## 10b. 30 mục ngẫu nhiên ĐỦ ĐIỀU KIỆN xuất bản (tiêu chí của nút xuất bản hàng loạt)

180/474 mục từ mới đủ điều kiện (đủ tầng A, không có ghi chú "cần xem"); giữ lại 294 mục, một mục có thể có nhiều lý do: Bộ kiểm tra của job báo lỗi 155, Nghi ngờ nghĩa 100, Còn lại (không nhận ra) 99, Từ nhạy cảm hoặc thô tục 21, Tên riêng 8. Chưa mục nào được xuất bản.

| từ | loại từ | CEFR | các nghĩa tiếng Việt (mỗi sense một nhóm) |
|---|---|---|---|
| nobody | pronoun, noun | A2 | (pronoun) không ai; chẳng ai · (noun) kẻ vô danh; người chẳng ra gì |
| partner | noun, verb | B1 | (noun) đối tác; bạn đồng hành; bạn nhảy · (noun) bạn đời; người yêu; vợ chồng · (verb) hợp tác; cộng tác; kết đối tác |
| future | noun, adjective | B1 | (noun) tương lai; thời gian sắp tới · (noun) triển vọng; số phận · (noun) thì tương lai · (adjective) tương lai; sau này |
| land | noun, verb | A2 | (noun) đất liền; mặt đất · (noun) đất đai; thửa đất · (noun) đất nước; vùng đất · (noun) đất canh tác; đất trồng · (verb) hạ cánh; đáp xuống · (verb) cập bờ; đưa vào bờ |
| hour | noun | A1 | (noun) giờ; tiếng · (noun) thời điểm; giờ · (noun) giờ làm; số giờ làm việc |
| hotel | noun | A1 | (noun) khách sạn; nhà nghỉ · (noun) dinh thự; biệt thự lớn · (noun) quán rượu; quán bia |
| march | noun, verb | B1 | (noun) bước đều; diễu hành · (noun) cuộc tuần hành; cuộc biểu tình · (verb) đi đều bước; diễu hành · (verb) áp giải; dẫn đi · (verb) tuần hành; biểu tình |
| sorry | adjective, exclamation | A1 | (adjective) xin lỗi; hối hận; ân hận · (adjective) thương hại; buồn; tiếc · (adjective) tồi tàn; thảm hại; đáng thương · (adjective) tệ hại; kém cỏi · (exclamation) xin lỗi; rất tiếc · (exclamation) xin lỗi, bạn nói gì cơ; cho hỏi lại |
| traffic | noun, verb | B2 | (noun) giao thông; xe cộ qua lại · (noun) buôn bán; buôn lậu · (noun) lượng khách; lượng truy cập · (noun) lưu lượng dữ liệu; lưu lượng truyền tải · (verb) buôn bán; buôn lậu |
| from | preposition | A1 | (preposition) từ; của; đến từ · (preposition) từ; kể từ · (preposition) từ; đến |
| him | pronoun, noun | A1 | (pronoun) anh ấy; ông ấy; cậu ấy · (noun) con đực; người đàn ông |
| each | determiner, adverb, pronoun, noun | A1 | (determiner) mỗi; từng · (adverb) mỗi cái; mỗi người · (adverb) riêng từng người; mỗi người · (pronoun) mỗi người; mỗi cái · (noun) một đơn vị; một cái lẻ |
| October | noun | A1 | (noun) tháng mười |
| wonderful | adjective, adverb | A2 | (adjective) tuyệt vời; tuyệt diệu; rất tốt · (adjective) kỳ diệu; phi thường; đáng kinh ngạc · (adverb) vô cùng; cực kỳ |
| live | verb, adjective, adverb | A2 | (verb) sống; còn sống · (verb) sống ở; cư trú; ở · (verb) tồn tại; sống sót · (adjective) sống; đang sống · (adjective) trực tiếp · (adverb) trực tiếp |
| house | noun, verb | A1 | (noun) ngôi nhà; căn nhà · (noun) công ty; hãng · (noun) hạ viện; viện · (noun) khán giả; buổi diễn · (verb) cho ở; chứa; đặt vào |
| design | noun, verb | B1 | (noun) bản thiết kế; kế hoạch; mẫu thiết kế · (noun) kiểu dáng; họa tiết; mẫu hoa văn · (noun) ý đồ; mưu đồ · (verb) thiết kế; phác thảo |
| fact | noun | A2 | (noun) sự thật; thực tế · (noun) thông tin; dữ kiện · (noun) hành vi phạm tội |
| style | noun, verb | B1 | (noun) phong cách; lối; kiểu · (noun) phong độ; gu; vẻ sang · (noun) kiểu dáng; mốt · (noun) kim đồng hồ mặt trời; vòi nhụy · (verb) thiết kế; tạo kiểu · (verb) gọi là; phong tước |
| remember | verb | A1 | (verb) nhớ lại; hồi tưởng; gợi nhớ · (verb) ghi nhớ; nhớ kỹ; thuộc lòng · (verb) nhớ làm; đừng quên · (verb) để lại cho; tặng tiền · (verb) gửi lời hỏi thăm; gửi lời chào |
| little | adjective, adverb, determiner, noun | A1 | (adjective) nhỏ; bé; nhỏ bé · (adjective) ngắn; không xa · (adverb) ít; một chút · (adverb) hoàn toàn không; chẳng hề · (determiner) ít; một chút · (noun) một chút; chút ít |
| think | verb, noun | A1 | (verb) suy nghĩ; cân nhắc · (verb) nghĩ rằng; cho rằng; tin rằng · (verb) hình dung; nghĩ tới · (verb) định; dự định · (noun) sự suy nghĩ; lần suy nghĩ |
| word | noun, verb, exclamation | A1 | (noun) từ; chữ · (noun) lời hứa; tin tức · (verb) diễn đạt; viết · (exclamation) đúng vậy; chuẩn luôn |
| date | noun, verb | A2 | (noun) ngày tháng; ngày · (noun) quả chà là; trái chà là · (noun) buổi hẹn hò; cuộc hẹn; người hẹn hò · (verb) ghi ngày; đề ngày · (verb) xác định niên đại; định tuổi · (verb) hẹn hò |
| else | adjective, adverb, conjunction | A2 | (adjective) khác; thêm · (adverb) cách khác; thời điểm khác; nếu không · (conjunction) nếu không thì; kẻo |
| follow | verb | A2 | (verb) đi theo; bám theo; đuổi theo · (verb) xảy ra sau; nối theo; tiếp theo · (verb) làm theo; tuân theo; thực hiện theo · (verb) hiểu; theo kịp; nắm được · (verb) theo dõi; chú ý đến · (verb) theo dõi; đăng ký theo dõi |
| here | adverb, noun | A1 | (adverb) ở đây; tại đây · (adverb) đến đây; lúc này · (adverb) về điểm này; trong vấn đề này · (adverb) đã đến; hiện tại · (noun) nơi này; chỗ này |
| ride | verb, noun | A2 | (verb) cưỡi; đi xe · (verb) đi nhờ xe; được chở · (verb) lướt đi; bay đi · (noun) chuyến đi; buổi cưỡi · (noun) chuyến đi nhờ; sự đưa đón · (noun) trò chơi cảm giác mạnh; trò chơi tàu lượn |
| ready | adjective, verb, noun | A2 | (adjective) sẵn sàng; chuẩn bị xong · (adjective) sẵn lòng; vui lòng · (adjective) nhanh nhạy; lanh lợi · (verb) chuẩn bị; sửa soạn · (noun) tiền mặt |
| pay | verb, noun | A2 | (verb) trả tiền; thanh toán · (verb) gửi tiền; nộp vào · (verb) có lợi; đáng công · (noun) tiền lương; lương bổng |

## 11. Mười mục từ đầy đủ nội dung (ngẫu nhiên)

### problem  _(noun · A2 · chờ duyệt)_

- IPA: /ˈpɹɑbləm/ / /ˈpɹɒbləm/ · audio: có · `meaning_vi`: vấn đề; bài toán; điều khó hiểu; sự phản đối; vấn đề nghiện; khó khăn
- (noun) A difficulty that needs to be solved or dealt with. → **vấn đề; khó khăn; trở ngại**
  - We have a serious problem with the computer system. — Chúng tôi đang gặp một vấn đề nghiêm trọng với hệ thống máy tính.
- (noun) A question to be answered, especially an exercise in a math or science class. → **bài toán; bài tập**
  - Students must solve five problems before the next class. — Học sinh phải giải năm bài toán trước buổi học tiếp theo.
- (noun) A situation that is puzzling or hard to understand. → **điều khó hiểu; bí ẩn**
  - The missing money is a problem that the police still cannot explain. — Số tiền bị mất là một bí ẩn mà cảnh sát vẫn chưa giải thích được.
- (noun) An objection, or a reason someone is unhappy about something. → **sự phản đối; sự bất bình**
  - If you have a problem with my decision, tell me now. — Nếu bạn phản đối quyết định của tôi, hãy nói ngay bây giờ.
- (noun) A condition such as an addiction or other psychological difficulty. → **vấn đề nghiện; rối loạn tâm lý**
  - She admitted that she has a drinking problem. — Cô ấy thừa nhận mình có vấn đề nghiện rượu.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: 67ed51f2-f4b3-4283-906f-fd8cc671f914 · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=A2 · loại từ của Wiktionary không có trong mục: adjective · ghi chú của Haiku: Nghĩa tính từ và động từ trong dữ liệu nguồn là nghĩa hiếm, không tiêu chu

### stand  _(verb, noun · A2 · chờ duyệt)_

- IPA: - / /ˈstænd/ · audio: có · `meaning_vi`: đứng; đứng dậy; đặt thẳng đứng; sự đứng; lập trường; giá đỡ
- (verb) To be on your feet in an upright position, supporting your body on your legs. → **đứng; đứng thẳng**
  - I can't reach the top shelf, so I have to stand on a chair. — Tôi không với tới kệ trên cùng, nên phải đứng lên ghế.
- (verb) To get up onto your feet from a sitting or lying position. → **đứng dậy; đứng lên**
  - Please stand up and walk to the door. — Xin hãy đứng dậy và đi ra cửa.
- (verb) To be placed in an upright position, or to place something upright. → **đặt thẳng đứng; dựng lên**
  - She stood the broom in the corner and went to rest. — Cô ấy dựng cây chổi vào góc nhà rồi đi nghỉ.
- (noun) The act of standing, or a position taken while standing. → **sự đứng; tư thế đứng**
  - He took his stand at the top of the hill to watch the view. — Anh ấy đứng ở đỉnh đồi để ngắm cảnh.
- (noun) A firm, clear position you take on an issue, especially against opposition. → **lập trường; quan điểm kiên định**
  - The company took a firm stand against illegal copying. — Công ty có lập trường kiên quyết chống sao chép trái phép.
- (noun) A support or frame on which something is placed or hung upright. → **giá đỡ; chân đế**
  - He placed the music sheets on the music stand. — Anh ấy đặt bản nhạc lên giá nhạc.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: 0491bf62-e2e2-4dca-b57e-c2d265934eaa · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · thiếu tầng B: is_countable · ước tính: cefr_level=A2 · ghi chú của Haiku: Đã gộp nghĩa 'quầy hàng' vào nghĩa 'giá đỡ' để đủ giới hạn 6 sense; nghĩa 'quầy hàng' và 'buổi biểu 

### here  _(adverb, noun · A1 · chờ duyệt)_

- IPA: /ˈhɪɚ̯/ / /ˈhɪə̯/ · audio: có · `meaning_vi`: ở đây; đến đây; về điểm này; đã đến; nơi này; tại đây
- (adverb) In, on, or at this place, which is close to the speaker. → **ở đây; tại đây**
  - You wait here while I fetch my coat. — Bạn đợi ở đây trong lúc tôi lấy áo khoác.
  - Ms. Doe is not here at the moment. — Cô Doe hiện không có ở đây.
- (adverb) At this point or stage in a process, argument, or narration. → **đến đây; lúc này**
  - I've had enough of peeling potatoes. I'm stopping here. — Tôi đã chán gọt khoai tây rồi. Tôi dừng lại ở đây.
- (adverb) In this matter; on this particular point. → **về điểm này; trong vấn đề này**
  - You say that all men are born equal, but here I must disagree with you. — Bạn nói rằng mọi người sinh ra đều bình đẳng, nhưng về điểm này tôi phải không đồng ý với bạn.
- (adverb) Now present or arrived, as an event or situation happening at the current time. → **đã đến; hiện tại**
  - Flu season is here. — Mùa cúm đã đến rồi.
  - Christmas will soon be here. — Giáng sinh sắp đến rồi.
- (noun) This place or location. → **nơi này; chỗ này**
  - Here is where I met my spouse twelve years ago. — Chính nơi này là nơi tôi gặp vợ/chồng mình mười hai năm trước.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, haiku · model: claude-haiku-5-5 · job: 9c42b119-358e-4254-8865-34c6a880edff · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=A1 · loại từ của Wiktionary không có trong mục: adjective, exclamation · ghi chú của Haiku: Từ điển nguồn có mục adjective nghĩa 'alive' (còn sống) với ví dụ hợp lệ, nhưng đây là cách dùng th

### modern  _(adjective, noun · B1 · chờ duyệt)_

- IPA: /ˈmɑ.dɚn/ / /ˈmɒd.ən/ · audio: có · `meaning_vi`: hiện đại; thuộc thời kỳ hiện đại; người hiện đại; đương đại; cận hiện đại; người thời nay
- (adjective) Relating to the present time or recent times, and to the style of today; not ancient or old-fashioned. → **hiện đại; đương đại; mới**
  - The museum has a modern wing with bright galleries. — Bảo tàng có một cánh hiện đại với những phòng trưng bày sáng sủa.
  - She prefers modern furniture to antiques. — Cô ấy thích đồ nội thất hiện đại hơn đồ cổ.
- (adjective) Relating to the period from about 1800 until today, especially in the study of history. → **thuộc thời kỳ hiện đại; cận hiện đại**
  - Historians often study modern politics separately from earlier periods. — Các nhà sử học thường nghiên cứu chính trị hiện đại tách biệt với các giai đoạn trước.
  - This course covers modern European history. — Khóa học này bao quát lịch sử châu Âu hiện đại.
- (noun) A person who lives in modern times, especially one with modern attitudes. → **người hiện đại; người thời nay**
  - The moderns often rely on technology in their daily lives. — Những người hiện đại thường dựa vào công nghệ trong đời sống hằng ngày.
  - Some writers criticised the moderns for losing old traditions. — Một số nhà văn chỉ trích người hiện đại vì đánh mất truyền thống xưa.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: d92c7531-05a4-4a47-815d-a4a1d520f1d7 · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · thiếu tầng B: is_countable · ước tính: cefr_level=B1 · ghi chú của Haiku: Sense 2 (lịch sử học) là nghĩa chuyên ngành; có thể cân nhắc gộp với sense 1. | Sense 3 (danh từ) có

### statement  _(noun, adjective, verb · B1 · chờ duyệt)_

- IPA: /ˈsteɪtmənt/ / /ˈsteɪtm(ə)nt/ · audio: có · `meaning_vi`: tuyên bố; sao kê; câu lệnh; quyết định; lập văn bản chính thức; lời tuyên bố
- (noun) A remark or declaration that is made publicly or formally, giving someone's opinion or position. → **tuyên bố; lời tuyên bố; phát biểu**
  - The company issued a statement denying the rumours. — Công ty đã ra một thông cáo phủ nhận những tin đồn.
  - She made a statement to the press about the decision. — Bà ấy đã có một tuyên bố với báo chí về quyết định đó.
- (noun) A printed document that lists the money paid in and out of a bank or credit account over a period. → **sao kê; bản kê khoản**
  - Your monthly bank statement arrives by email. — Bản sao kê ngân hàng hàng tháng của bạn được gửi qua email.
  - Check your credit card statement for any unfamiliar charges. — Hãy kiểm tra bản sao kê thẻ tín dụng xem có khoản phí lạ nào không.
- (noun) An instruction in a computer program that performs an action but does not return a value. → **câu lệnh**
  - Each statement in the loop runs once per iteration. — Mỗi câu lệnh trong vòng lặp chạy một lần mỗi vòng.
  - A missing semicolon can cause a syntax error in this statement. — Thiếu dấu chấm phẩy có thể gây lỗi cú pháp trong câu lệnh này.
- (adjective) Decisive and impressive, often showing strength or a clear message. → **quyết định; gây ấn tượng mạnh**
  - They secured a statement win against the reigning champions. — Họ giành được chiến thắng gây ấn tượng mạnh trước nhà vô địch.
  - The designer's statement jacket turned heads at the event. — Chiếc áo khoác nổi bật của nhà thiết kế thu hút mọi ánh nhìn tại sự kiện.
- (verb) To officially provide a formal written document setting out a proposition, especially a special educational needs statement in the UK. → **lập văn bản chính thức**
  - The council decided to statement the child's special educational needs. — Hội đồng quyết định lập văn bản chính thức về nhu cầu giáo dục đặc biệt của đứa trẻ.
  - They were statemented after a long assessment. — Họ đã được lập văn bản chính thức sau một đợt đánh giá dài.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: 075b407e-3f57-49c3-a2b0-82a57c2ce99e · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=B1 · ghi chú của Haiku: Nghĩa 'quyết định, gây ấn tượng' của tính từ là nghĩa đặc thù, có thể cần xem lại mức phổ biến. | Nghĩa động từ thuộc ngữ cảnh An

### fun  _(noun, adjective, verb · A2 · chờ duyệt)_

- IPA: /fʌn/ / /fʌn/ · audio: có · `meaning_vi`: niềm vui; trò đùa nghịch; vui vẻ; sặc sỡ; trêu chọc; sự thú vị
- (noun) Enjoyment, amusement or pleasure that you get from an activity or experience. → **niềm vui; sự thú vị; sự giải trí**
  - Grafting your boss's face onto the hind end of a donkey is fun, but serious fun is when you create the impossible and it looks real. — Ghép mặt sếp lên mông lừa thì thật vui, nhưng niềm vui thật sự là khi bạn tạo ra điều không thể mà trông vẫn chân thực.
  - We had great fun at the beach all afternoon. — Chúng tôi đã có những giờ phút vui vẻ tuyệt vời ở bãi biển cả buổi chiều.
- (noun) Playful activity that is often noisy and energetic. → **trò đùa nghịch; sự nô đùa**
  - The children's fun in the garden got a little too loud for the neighbours. — Trò nô đùa của bọn trẻ trong vườn làm hàng xóm thấy hơi ồn ào.
  - Stop the fun before someone gets hurt. — Dừng trò đùa nghịch lại trước khi ai đó bị thương.
- (adjective) Enjoyable, entertaining or amusing to be with or to do. → **vui vẻ; thú vị**
  - We had a fun time at the party. — Chúng tôi đã có một buổi tiệc rất vui.
  - He is such a fun person to be with. — Anh ấy là người rất thú vị khi ở cạnh.
- (adjective) Bright, playful or flamboyant in style, especially clothing. → **sặc sỡ; lạ mắt**
  - This year's fashion style is much more fun than recent seasons. — Phong cách thời trang năm nay sặc sỡ hơn nhiều so với các mùa gần đây.
  - She wore a fun pair of striped socks with her suit. — Cô ấy đi đôi tất kẻ sọc lạ mắt cùng bộ vest.
- (verb) To tease someone or make fun of them in a light-hearted way. → **trêu chọc; đùa cợt**
  - Don't get upset; I was only funning you. — Đừng bực mình; tôi chỉ trêu bạn thôi.
  - My brother spent the whole evening funning me about my haircut. — Anh trai tôi trêu tôi suốt buổi tối về kiểu tóc của tôi.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: 9f453d9c-ecc0-48f4-97de-7417cf326b1f · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=A2 · ghi chú của Haiku: Dạng so sánh funner, funnest chỉ là không chuẩn, không đưa vào senses. | Nghĩa động từ thuộc khẩu ngữ, cần kiểm tra lại mức độ ph

### hotel  _(noun · A1 · chờ duyệt)_

- IPA: - / /həʊˈtɛl/ · audio: có · `meaning_vi`: khách sạn; dinh thự; quán rượu; nhà nghỉ; biệt thự lớn; quán bia
- (noun) A building where paying guests can stay overnight, with rooms, meals and other services. → **khách sạn; nhà nghỉ**
  - We booked a room at a hotel near the beach. — Chúng tôi đặt một phòng ở khách sạn gần bãi biển.
  - The hotel offers free breakfast to all guests. — Khách sạn cung cấp bữa sáng miễn phí cho mọi khách.
- (noun) A large, grand private house in France, especially one belonging to a wealthy family in the past. → **dinh thự; biệt thự lớn**
  - The old hotel in Paris had been home to a noble family. — Dinh thự cũ ở Paris từng là nơi ở của một gia đình quý tộc.
- (noun) A public house where people go to drink alcohol, used in Australia, Canada and western regions. → **quán rượu; quán bia**
  - After work, we went to the hotel for a quick drink. — Sau giờ làm, chúng tôi ghé quán rượu uống nhanh một ly.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, haiku · model: claude-haiku-5-5 · job: fa87e36d-a3f3-4324-90c5-c1fd671185a3 · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=A1 · ghi chú của Haiku: Nghĩa 'nhà khách/restaurant' ở Nam Á và nghĩa 'quân hiệu Hotel' bị bỏ qua vì hiếm hoặc không phổ biến. | Nghĩa 'khách sạn lớn trong Monopoly' bị bỏ vì chuyên biệt. | N

### easy  _(adjective, adverb, noun · A1 · chờ duyệt)_

- IPA: /ˈiːzi/ / - · audio: có · `meaning_vi`: dễ dàng; thoải mái; dễ tính; việc dễ dàng; đơn giản; thanh thản
- (adjective) Requiring little skill, effort, or work to do or achieve. → **dễ dàng; đơn giản**
  - The teacher gave an easy test to her students. — Giáo viên đã cho học sinh một bài kiểm tra dễ.
  - Fixing the bike was easy once I found the right tool. — Sửa chiếc xe đạp rất dễ khi tôi tìm được đúng dụng cụ.
- (adjective) Relaxed and free from worry, discomfort, or strain. → **thoải mái; thanh thản**
  - Now that the exams are over, I can finally feel easy. — Giờ kỳ thi đã xong, cuối cùng tôi cũng thấy thanh thản.
  - She lives an easy life in the countryside. — Cô ấy sống một cuộc đời thoải mái ở vùng quê.
- (adjective) Free from strictness, harshness, or formality; relaxed in manner. → **dễ tính; nhẹ nhàng**
  - Her easy manners made everyone feel welcome. — Cách cư xử dễ tính của cô ấy khiến mọi người cảm thấy được chào đón.
  - The coach was easy on the players after the long season. — Huấn luyện viên nhẹ nhàng với các cầu thủ sau mùa giải dài.
- (adverb) In a relaxed or casual way; without hurry or strain. → **thoải mái; nhẹ nhàng**
  - After his illness, John decided to take it easy. — Sau khi ốm, John quyết định nghỉ ngơi thoải mái.
  - Just go easy on the sugar in your tea. — Chỉ cần cho ít đường vào trà thôi.
- (noun) Something that is easy to do or achieve. → **việc dễ dàng**
  - For him, the final round was an easy. — Với anh ấy, vòng cuối là việc dễ dàng.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: 43263ad2-2b1d-49bc-9c76-8f3ef221bb0d · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · thiếu tầng B: is_countable · ước tính: cefr_level=A1 · [ipa-untagged] ipa_us lấy từ IPA đầu tiên không gắn thẻ giọng của Wiktionary, không rõ giọng · loại từ của Wiktionary k

### need  _(noun, verb · A2 · chờ duyệt)_

- IPA: /nid/ / /niːd/ · audio: có · `meaning_vi`: nhu cầu; nhu cầu thiết yếu; cảnh nghèo khó; cần; muốn; phải
- (noun) A requirement for something; something that is necessary or wanted. → **nhu cầu; sự cần thiết**
  - There is no need to speculate; we can easily find out for sure. — Không cần phải suy đoán; chúng ta có thể dễ dàng tìm ra chắc chắn.
  - She grew irritated with his constant need for attention. — Cô ấy trở nên khó chịu vì anh ấy luôn đòi hỏi được chú ý.
- (noun) A strong desire or craving for something considered essential or basic. → **nhu cầu thiết yếu; sự thôi thúc**
  - Humans have a basic need for food, water and shelter. — Con người có nhu cầu cơ bản về thức ăn, nước uống và chỗ ở.
- (noun) A state of having too little money or resources to live properly. → **cảnh nghèo khó; sự túng thiếu**
  - The charity helps families living in need. — Tổ chức từ thiện giúp đỡ các gia đình đang túng thiếu.
- (verb) To require something because it is essential for existence or success. → **cần; đòi hỏi**
  - Living things need water to survive. — Sinh vật sống cần nước để tồn tại.
  - You do not always need to go to the library to study. — Bạn không nhất thiết phải đến thư viện để học.
- (verb) To want something very much or feel that you must have it. → **muốn; mong cần**
  - After ten days of hiking, I needed a shower and a shave. — Sau mười ngày đi bộ đường dài, tôi rất cần tắm và cạo râu.
- (verb) To be obliged or required to do something; used with a bare infinitive, mainly in negatives and questions. → **phải; cần phải**
  - I need not go if I don't want to. — Tôi không nhất thiết phải đi nếu tôi không muốn.
  - Need I fill in more forms? — Tôi có cần điền thêm mẫu đơn nào không?
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, haiku · model: claude-haiku-5-5 · job: adf0be2f-859c-4ce4-a356-225f61367186 · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=A2 · ghi chú của Haiku: Nghĩa danh từ 'poverty' được xếp là trang trọng và có thể cổ; cân nhắc giữ hoặc bỏ. | Nguồn Wiktionary có ghi nghĩa động từ 'need' là động từ khuyết thiếu; đã giữ nghĩ

### fourth  _(adjective, noun, verb · A2 · chờ duyệt)_

- IPA: /fɔɹθ/ / /fɔːθ/ · audio: có · `meaning_vi`: thứ tư; một phần tư; người thứ tư; tán thành sau người thứ ba; vật thứ tư
- (adjective) Coming after the third one in a sequence or order. → **thứ tư**
  - She is the fourth daughter in the family. — Cô ấy là con gái thứ tư trong gia đình.
  - He finished the race in fourth place. — Anh ấy về thứ tư trong cuộc đua.
- (noun) One of four equal parts of a whole. → **một phần tư**
  - Cut the cake into fourths. — Cắt chiếc bánh thành bốn phần bằng nhau.
- (noun) The person or thing in the fourth position. → **người thứ tư; vật thứ tư**
  - He arrived as the fourth in line. — Anh ấy đến ở vị trí thứ tư trong hàng.
- (verb) To agree with a proposal after others have already agreed to it. → **tán thành sau người thứ ba**
  - After the third member agreed, he fourthed the motion without hesitation. — Sau khi người thứ ba đồng ý, anh ấy tán thành đề nghị mà không do dự.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: 79b91bf9-7f58-44a5-8dee-2095f4a82ae5 · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · thiếu tầng B: is_transitive · ước tính: cefr_level=A2 · ghi chú của Haiku: Nghĩa 'tán thành sau người thứ ba' là cách dùng hiếm, đã giữ lại vì có trong dữ liệu nguồn; cân nhắ

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

### Giai đoạn 2: 500 từ (20/10/2026)

Phần được sinh tự động ở trên (`--report --from-run 2`) chỉ nói về giai đoạn 2 (lần gửi #2 và #3); số liệu giai đoạn 1 nằm ở ghi chú giai đoạn 1.

* **Cách chạy.** `ENRICHMENT_ENABLED=true`, `ENRICHMENT_PUBLISH_POLICY=review`, `ENRICHMENT_MAX_JOBS_PER_DAY=1000` (lệnh gửi), `ENRICHMENT_WORKER_CONCURRENCY=2` (worker); không sửa `.env`. `--limit 500`: 500 từ đầu theo thứ tự CEFR rồi tần suất, nên **cả 500 từ đều là A1 và là những từ thông dụng nhất** (`the`, `to`, `of`, `in`, `i`, `for`…). Đây là lát cắt khó nhất của danh sách (từ càng thông dụng càng nhiều nghĩa), nên tỉ lệ lỗi và chi phí dưới đây **không đại diện** cho 3.500 từ còn lại. Worker chạy ở tab Terminal của bạn (log `oxford-seed-phase2-worker.log`) và được tắt bằng **Ctrl-C (SIGINT)**: log có `shutdown_start SIGINT`, `pgboss.instance.stopped_on` có giá trị; không dùng `taskkill`. Một khác biệt nhỏ về thứ tự: worker phải được bật TRƯỚC khi gửi (kiểm tra "có worker của máy này" của chính công cụ), không phải sau.
* **Lượt đầu (lần #2, 500 từ).** Gửi xong sau 455 giây (worker đã chạy song song). 455 `succeeded` (91,0%), 15 `skipped / exists`, 2 `rejected / proper_noun`, **28 `failed / invalid_output` = 5,6%**, dưới ngưỡng dừng 8% (40/500). Không có 429, không hết ngân sách, không `upstream_error`; hai job được pg-boss thử lại, cả hai sau đó thành công: `let` (Anthropic quá hạn 60 giây) và `guess` (Free Dictionary quá hạn 2,5 giây). Thời gian: từ job đầu đến job cuối **66,6 phút** (8,0 giây/từ trên đồng hồ treo tường); một job chạy trung vị 12,2 giây, p95 26,3 giây, lâu nhất 87,2 giây (log worker).
* **Gửi lại.** Chạy thử `--retry-last-run` cho **27 từ** (28 từ hỏng của lượt đầu trừ `into`, đã hỏng cả ở giai đoạn 1 nên đủ hai lượt và coi là kết thúc); 0 từ đang trong hàng đợi, 455 từ đã có mục từ và 15 từ đã là dạng biến bị loại, nên không có job trùng. Gửi thật: 27 job mới trong 28 giây; kết quả **19 thành mục từ, 8 hỏng lần nữa** (5 `schema_too_big`, 3 `classifier_duplicate`), 3,4 phút. Hàng sổ cũ của 27 từ được giữ làm lịch sử.
* **Kết quả cuối của giai đoạn 2.** **474 mục từ mới** (`published = false`), 15 `skipped / exists`, 2 `rejected / proper_noun`, 9 `failed / invalid_output` còn lại (`half`, `help`, `hope`, `into`, `out`, `right`, `slow`, `welcome`, `you`).
* **`invalid_output` theo validator.** Lượt đầu, bản nháp cuối vi phạm: `schema_too_big @ senses` ở **24/28 từ** (bản đầu: 25/28), `classifier_duplicate @ senses[].meanings_vi[]` ở 3, `parenthesis` ở 1. `schema_too_big` là Haiku viết **hơn 6 sense**: với từ nhiều nghĩa (`out`, `off`, `right`, `still`, `give`, `place`, `let`…) lần sửa gần như không bao giờ rút xuống 6 (24 trên 25 vẫn quá). Token ra trung vị của job hỏng là 4.340 (hai lần gọi), gấp khoảng 2,6 lần job thành công (1.645). Theo loại từ (loại từ Oxford của hàng có mức thấp nhất): tính từ 8/89 (9,0%), danh từ 7/211 (3,3%), động từ 4/74 (5,4%), trạng từ 3/52 (5,8%), đại từ 2/20 (10%), hạn định từ 2/17 (11,8%), giới từ 1/8, thán từ 1/6; không có ở số từ, trợ động từ, liên từ, mạo từ. Đây là lỗi **có hệ thống** của từ nhiều nghĩa, không phải ngẫu nhiên; gửi lại cứu được 19/27 (70%) vì Haiku không tất định, nhưng các từ nhiều nghĩa nhất (`out`, `right`, `into`) vẫn hỏng. Chưa sửa gì ở validator hay prompt (ngoài phạm vi); hai hướng hợp lý: cắt còn 6 sense đầu thay vì từ chối, hoặc nói rõ giới hạn 6 sense trong lời nhắc sửa.
* **Từ bị bỏ qua.** 15 `skipped / exists` **không phải lỗi**: mỗi từ đã trở thành dạng biến (`word_forms`) của một mục từ được tạo trong cùng đợt nên S0 thấy "đã có": `my` (của `i`), `his` (`he`), `our` (`we`), `its`, `them`, `they` (đều gắn vào `it`), `would` (`will`), `news` (`new`), `reading` (`read`), `meaning` (`mean`), `feeling` (`feel`), `evening` (`even`), `meeting` (`meet`), `interesting`, `interested` (`interest`). Một số trong đó có nghĩa riêng đáng có mục từ riêng (`news`, `evening`, `meeting`, `feeling`, `meaning`, `reading`) mà nay tra ra mục từ của từ gốc; `they` gắn vào `it` là cách Wiktionary xếp dạng số nhiều. 2 `rejected / proper_noun`: `february` và `july` (Haiku coi tên tháng là danh từ riêng, trong khi `october` lại được nhận) — không nhất quán, cần quyết định riêng.
* **Chi phí theo hàng sổ.** Lượt đầu 485 job gọi Haiku: 5,40 triệu token vào, 0,87 triệu ra, **0,632 USD**; gửi lại 27 job: 0,434 triệu vào, 0,078 triệu ra, **0,063 USD**. Tổng **0,695 USD** (bộ đếm: 0,70 USD) cho 474 mục từ mới, tức 0,0015 USD mỗi mục và 0,0014 USD mỗi job gọi Haiku. Ước tính trước khi gửi 0,48 USD (0,00090 USD/từ từ lịch sử giai đoạn 1): chi phí thực **gấp 1,44 lần**, dưới ngưỡng 2 lần nhưng sát hơn giai đoạn 1 (1,09), vì từ thông dụng nhiều nghĩa tốn gần gấp đôi token (trung bình job thành công 10.551 vào / 1.645 ra; job hỏng 20.960 / 4.263). **28 job hỏng của lượt đầu tốn 0,099 USD** (khoảng 0,0035 USD mỗi job, gấp 2,7 lần job thường) mà không cho ra mục từ. Với khoảng 3.500 từ còn lại, ước tính 4,5 đến 5,2 USD nếu cùng 0,0014 đến 0,0015 USD/từ (từ ít nghĩa hơn sẽ rẻ hơn).
* **Mục từ đủ điều kiện xuất bản.** 180/474 (38%) qua tiêu chí của nút xuất bản hàng loạt; 294 bị giữ vì ghi chú "cần xem": bộ kiểm tra của job báo lỗi 155, nghi ngờ nghĩa 100, không nhận ra 99, từ nhạy cảm 21, tên riêng 8 (một mục có thể có nhiều lý do). 30 mục ngẫu nhiên đủ điều kiện (mục 10b) cho thấy **tiêu chí tự động chưa đủ để tin**: vẫn có nghĩa hiếm hoặc lạc ngữ cảnh lọt vào, ví dụ `hotel` (dinh thự, quán rượu), `fact` (hành vi phạm tội), `style` (kim đồng hồ mặt trời, vòi nhụy), `remember` (để lại cho, tặng tiền), `march` (áp giải), `word` (đúng vậy, chuẩn luôn), `him` (con đực), và `October` được lập với headword viết hoa. Cần người duyệt trước khi xuất bản; không xuất bản mục nào.
* **Dữ liệu và dung lượng.** 474 mục từ mới có trung bình 4,45 sense và 9,30 nghĩa tiếng Việt; 23 mục thiếu `ipa_us` (2 thiếu cả hai IPA), 2 thiếu cả hai audio, không mục nào thiếu ví dụ. Cơ sở dữ liệu 251,41 MB → 256,73 MB (**+5,31 MB**, khoảng 11 KB mỗi mục từ với chỉ mục; dữ liệu thuần 2,75 MB, 5,9 KB mỗi mục). Với 3.497 từ còn lại, dự kiến thêm khoảng 38 MB trên đĩa (20 MB dữ liệu).
* **Thay đổi công cụ trong lúc làm** (đều có test): (1) `--retry-last-run` và luật "`invalid_output` được thử thêm đúng một lần, hỏng hai lần thì coi là kết thúc" (trước đó `invalid_output` đóng từ ngay, nên chạy thử lần hai sẽ báo 0 từ gửi lại); (2) dòng log `enrich` của worker có thêm `issues` / `first_issues` (mã validator và đường dẫn trường, **không có nội dung bản nháp**) khi `invalid_output`, để trả lời "validator nào"; (3) ước tính thời gian dùng khoảng cách giữa hai job xong liên tiếp thay vì `finished_at - created_at` (số cũ gồm cả thời gian chờ trong hàng đợi và cho ra "52 giây/từ", 3,6 giờ cho 500 từ; số mới 5,1 giây/từ, 43 phút; thực tế 8,0 giây/từ vì từ thông dụng chậm hơn); (4) `--report --from-run N`, bảng theo từng lần gửi, phân tích `invalid_output` theo từng lần gửi, và mục 10b (30 mục đủ điều kiện).

**Dừng ở đây. Chưa chạy giai đoạn 3, chưa `oxford:apply-cefr`, chưa `enrich:publish`, chưa sửa `.env`.**
