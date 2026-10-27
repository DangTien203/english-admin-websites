# Báo cáo nạp Oxford 5000

Đợt nạp các từ của danh sách Oxford 5000 chưa có trong từ điển, qua đường ống làm giàu P6. Cách chạy: `docs/lookup-runbook.md` mục 13. Oxford chỉ cung cấp danh sách từ, loại từ và mức CEFR; nội dung do đường ống tự viết.

<!-- BEGIN GENERATED (npm run enrich:seed-oxford -- --report) -->

Sinh lúc 2026-10-23T18:18:19.697Z bởi `npm run enrich:seed-oxford -- --file … --report`. Phạm vi: các lần gửi #1 đến #14. Phần này được ghi lại mỗi lần chạy; ghi chú viết tay nằm SAU dấu kết thúc và được giữ.

## 1. Dữ liệu vào và các lần gửi

File `oxford_5000.json`: 5,948 dòng, 4,958 từ khác nhau (chữ thường). Gộp 990 dòng trùng của 883 từ; 343 từ có nhiều mức CEFR (lấy mức thấp nhất); 5 dòng không có mức hợp lệ. Chỉ đọc từ, loại từ, mức CEFR; định nghĩa và ví dụ của Oxford không được dùng.

Độ phủ IPA/audio của file (từ hợp lệ, chỉ đếm, KHÔNG đưa vào mục từ): IPA 4,947/4,949 · audio US 4,949/4,949 · audio UK 4,949/4,949.

| # | bắt đầu (UTC) | kết thúc | cách chọn | từ đã gửi | dừng bởi | model | policy | đồng thời |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-10-20 05:58:04 | 05:58:33 | mẫu 50 | 50 | - | claude-haiku-5-5 | review | 2 |
| 2 | 2026-10-20 07:57:50 | 08:05:25 | limit 500 | 500 | - | claude-haiku-5-5 | review | 2 |
| 3 | 2026-10-20 09:06:04 | 09:06:31 | gửi lại từ lần trước | 27 | - | claude-haiku-5-5 | review | 2 |
| 4 | 2026-10-22 04:22:26 | 04:30:19 | limit 1000 | 7 | killed: the network dropped (ECONNRESET, DNS ENOTFOUND) and the next word hung; the record was rebuilt from the send log and the ledger | claude-haiku-5-5 | review | 2 |
| 5 | 2026-10-22 04:30:48 | 04:38:46 | limit 993 | 989 | - | claude-haiku-5-5 | review | 2 |
| 6 | 2026-10-22 05:45:58 | 05:46:13 | gửi lại từ lần trước | 27 | - | claude-haiku-5-5 | review | 2 |
| 7 | 2026-10-22 05:53:02 | 06:00:41 | limit 1000 | 998 | - | claude-haiku-5-5 | review | 2 |
| 8 | 2026-10-22 08:28:48 | 08:29:05 | gửi lại từ lần trước | 21 | - | claude-haiku-5-5 | review | 2 |
| 9 | 2026-10-22 08:39:46 | 08:53:46 | limit 1000 | 999 | - | claude-haiku-5-5 | review | 2 |
| 10 | 2026-10-22 09:31:59 | 09:32:13 | gửi lại từ lần trước | 18 | - | claude-haiku-5-5 | review | 2 |
| 11 | 2026-10-22 09:42:10 | 09:46:26 | limit 1000 | 440 | - | claude-haiku-5-5 | review | 2 |
| 12 | 2026-10-23 17:17:29 | 17:17:38 | gửi lại từ lần trước | 18 | - | claude-haiku-5-5 | review | 2 |
| 13 | 2026-10-23 17:58:34 | 17:58:40 | limit 1000 | 10 | - | claude-haiku-5-5 | review | 2 |
| 14 | 2026-10-23 18:09:45 | 18:09:47 | limit 1 · offset 4 | 1 | - | claude-haiku-5-5 | review | 2 |

## 2. Kết quả theo trạng thái và lý do

| status / reason | số từ |
|---|---|
| succeeded / - | 3891 |
| skipped / exists | 56 |
| failed / upstream_error | 14 |
| skipped / variant_form | 7 |
| failed / invalid_output | 5 |
| rejected / proper_noun | 2 |
| skipped / lemma_mismatch | 1 |

Tổng 3,976 từ đã gửi. Job còn `queued`/`running`: 0.

Job hết ngân sách hoặc lỗi nhà cung cấp (`budget`, `upstream_error`, `dead_letter`) ở job gần nhất của từ: 14.

**Theo từng lần gửi** (đếm HÀNG sổ do lần gửi đó tạo, nên hàng cũ của từ được gửi lại vẫn nằm ở lần gửi cũ của nó):

| status / reason | lần #1 (50 từ) | lần #2 (500 từ) | lần #3 (27 từ) | lần #4 (7 từ) | lần #5 (989 từ) | lần #6 (27 từ) | lần #7 (998 từ) | lần #8 (21 từ) | lần #9 (999 từ) | lần #10 (18 từ) | lần #11 (440 từ) | lần #12 (18 từ) | lần #13 (10 từ) | lần #14 (1 từ) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| failed / invalid_output | 2 | 28 | 8 | 0 | 27 | 8 | 20 | 2 | 14 | 2 | 2 | 1 | 0 | 0 |
| failed / upstream_error | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 4 | 4 | 16 | 21 | 10 | 0 |
| rejected / proper_noun | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| skipped / exists | 0 | 15 | 0 | 1 | 22 | 0 | 10 | 0 | 6 | 0 | 2 | 0 | 0 | 0 |
| skipped / lemma_mismatch | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| skipped / variant_form | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 3 | 0 | 2 | 0 | 0 | 0 |
| succeeded / - | 47 | 455 | 19 | 6 | 940 | 19 | 966 | 18 | 972 | 12 | 417 | 2 | 0 | 1 |

Tiêu chí dừng khẩn cấp: ở LƯỢT ĐẦU (lần #1, 50 từ) `invalid_output` là 2 (4.0%; dừng khi vượt 5% theo yêu cầu ban đầu, 8% ở giai đoạn 2); sau các lần gửi lại còn 5/3,976 từ hỏng (0.1%). Lỗi nhà cung cấp và chi phí: ở trên và mục 4.

**`invalid_output` theo nguyên nhân (validator) và loại từ, từng lần gửi**

*Lần #1* (50 từ): 2 job `invalid_output`, 2 không có chi tiết (worker cũ).

Luật mà bản nháp CUỐI (sau một lần sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| (không có chi tiết) | 0 |

Luật mà câu trả lời ĐẦU TIÊN (trước khi sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| (không có chi tiết) | 0 |

Theo loại từ (loại từ của hàng có mức CEFR thấp nhất trong file Oxford):

| loại từ | từ đã gửi | từ hỏng | tỉ lệ |
|---|---|---|---|
| noun | 8 | 0 | 0.0% |
| adverb | 6 | 0 | 0.0% |
| adjective | 6 | 0 | 0.0% |
| verb | 6 | 0 | 0.0% |
| preposition | 5 | 1 | 20.0% |
| conjunction | 5 | 0 | 0.0% |
| pronoun | 4 | 1 | 25.0% |
| determiner | 4 | 0 | 0.0% |
| exclamation | 2 | 0 | 0.0% |
| number | 2 | 0 | 0.0% |
| modal verb | 2 | 0 | 0.0% |

Token ra của các job hỏng: trung vị 2,636 (giới hạn `ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH` mặc định 4.000).

Từng từ:

| từ | loại từ (Oxford) | CEFR | luật vi phạm ở bản cuối |
|---|---|---|---|
| into | preposition | A1 | - |
| theirs | pronoun | B1 | - |

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

*Lần #5* (989 từ): 27 job `invalid_output`.

Luật mà bản nháp CUỐI (sau một lần sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 21 |
| classifier_duplicate @ senses[].meanings_vi[] | 3 |
| parenthesis @ senses[].meanings_vi[] | 1 |
| too_long @ senses[].definition_en | 1 |
| too_many_syllables @ senses[].meanings_vi[] | 1 |

Luật mà câu trả lời ĐẦU TIÊN (trước khi sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 23 |
| classifier_duplicate @ senses[].meanings_vi[] | 2 |
| too_long @ senses[].definition_en | 1 |
| too_many_syllables @ senses[].meanings_vi[] | 1 |

Theo loại từ (loại từ của hàng có mức CEFR thấp nhất trong file Oxford):

| loại từ | từ đã gửi | từ hỏng | tỉ lệ |
|---|---|---|---|
| noun | 596 | 16 | 2.7% |
| adjective | 191 | 7 | 3.7% |
| verb | 105 | 3 | 2.9% |
| adverb | 54 | 0 | 0.0% |
| number | 19 | 0 | 0.0% |
| pronoun | 8 | 0 | 0.0% |
| preposition | 6 | 1 | 16.7% |
| conjunction | 3 | 0 | 0.0% |
| exclamation | 2 | 0 | 0.0% |
| determiner | 2 | 0 | 0.0% |
| ordinal number | 1 | 0 | 0.0% |
| linking verb | 1 | 0 | 0.0% |
| modal verb | 1 | 0 | 0.0% |

Token ra của các job hỏng: trung vị 3,863 (giới hạn `ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH` mặc định 4.000).

Từng từ:

| từ | loại từ (Oxford) | CEFR | luật vi phạm ở bản cuối |
|---|---|---|---|
| deep | adjective, adverb | A2 | schema_too_big @ senses |
| drop | noun, verb | A2 | schema_too_big @ senses |
| flat | adjective, noun | A1 | schema_too_big @ senses |
| function | noun, verb | B1 | schema_too_big @ senses |
| golf | noun | A2 | too_long @ senses[].definition_en |
| heavy | adjective | A2 | schema_too_big @ senses |
| hit | noun, verb | A2 | schema_too_big @ senses |
| human | adjective, noun | A2 | classifier_duplicate @ senses[].meanings_vi[] |
| level | adjective, noun, verb | A2 | schema_too_big @ senses |
| loss | noun | B1 | schema_too_big @ senses |
| narrow | adjective, verb | A2 | schema_too_big @ senses |
| nose | noun | A1 | schema_too_big @ senses |
| offer | noun, verb | A2 | schema_too_big @ senses |
| opposite | adjective, adverb, noun, preposition | A1 | schema_too_big @ senses |
| platform | noun | A2 | schema_too_big @ senses |
| plus | adjective, conjunction, noun, preposition | B1 | schema_too_big @ senses |
| profile | noun | A2 | schema_too_big @ senses |
| quarter | noun | A1 | classifier_duplicate @ senses[].meanings_vi[] |
| save | verb | A2 | schema_too_big @ senses |
| score | noun, verb | A2 | schema_too_big @ senses |
| sheet | noun | A2 | schema_too_big @ senses |
| shower | noun | A1 | parenthesis @ senses[].meanings_vi[] |
| touch | noun, verb | A2 | classifier_duplicate @ senses[].meanings_vi[] |
| trainer | noun | A2 | too_many_syllables @ senses[].meanings_vi[] |
| underground | adjective, adverb | A2 | schema_too_big @ senses |
| value | noun, verb | B1 | schema_too_big @ senses |
| warm | adjective, verb | A1 | schema_too_big @ senses |

*Lần #6* (27 từ): 8 job `invalid_output`.

Luật mà bản nháp CUỐI (sau một lần sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 8 |

Luật mà câu trả lời ĐẦU TIÊN (trước khi sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 8 |

Theo loại từ (loại từ của hàng có mức CEFR thấp nhất trong file Oxford):

| loại từ | từ đã gửi | từ hỏng | tỉ lệ |
|---|---|---|---|
| noun | 16 | 4 | 25.0% |
| adjective | 7 | 3 | 42.9% |
| verb | 3 | 0 | 0.0% |
| preposition | 1 | 1 | 100.0% |

Token ra của các job hỏng: trung vị 3,812 (giới hạn `ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH` mặc định 4.000).

Từng từ:

| từ | loại từ (Oxford) | CEFR | luật vi phạm ở bản cuối |
|---|---|---|---|
| flat | adjective, noun | A1 | schema_too_big @ senses |
| function | noun, verb | B1 | schema_too_big @ senses |
| hit | noun, verb | A2 | schema_too_big @ senses |
| level | adjective, noun, verb | A2 | schema_too_big @ senses |
| opposite | adjective, adverb, noun, preposition | A1 | schema_too_big @ senses |
| plus | adjective, conjunction, noun, preposition | B1 | schema_too_big @ senses |
| underground | adjective, adverb | A2 | schema_too_big @ senses |
| warm | adjective, verb | A1 | schema_too_big @ senses |

*Lần #7* (998 từ): 20 job `invalid_output`.

Luật mà bản nháp CUỐI (sau một lần sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 15 |
| classifier_duplicate @ senses[].meanings_vi[] | 3 |
| too_many_syllables @ senses[].meanings_vi[] | 2 |

Luật mà câu trả lời ĐẦU TIÊN (trước khi sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 18 |
| classifier_duplicate @ senses[].meanings_vi[] | 1 |
| too_many_syllables @ senses[].meanings_vi[] | 1 |

Theo loại từ (loại từ của hàng có mức CEFR thấp nhất trong file Oxford):

| loại từ | từ đã gửi | từ hỏng | tỉ lệ |
|---|---|---|---|
| noun | 552 | 14 | 2.5% |
| adjective | 266 | 5 | 1.9% |
| verb | 109 | 0 | 0.0% |
| adverb | 66 | 1 | 1.5% |
| conjunction | 2 | 0 | 0.0% |
| pronoun | 2 | 0 | 0.0% |
| preposition | 1 | 0 | 0.0% |

Token ra của các job hỏng: trung vị 4,086 (giới hạn `ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH` mặc định 4.000).

Từng từ:

| từ | loại từ (Oxford) | CEFR | luật vi phạm ở bản cuối |
|---|---|---|---|
| handle | noun, verb | B2 | schema_too_big @ senses |
| junior | adjective | B2 | schema_too_big @ senses |
| margin | noun | B2 | too_many_syllables @ senses[].meanings_vi[] |
| overnight | adverb | B2 | schema_too_big @ senses |
| principal | adjective, noun | B2 | schema_too_big @ senses |
| rank | noun, verb | B2 | schema_too_big @ senses |
| root | noun | B2 | schema_too_big @ senses |
| scratch | noun, verb | B2 | classifier_duplicate @ senses[].meanings_vi[] |
| sensitive | adjective | B2 | schema_too_big @ senses |
| shade | noun | B2 | schema_too_big @ senses |
| shadow | noun | B2 | schema_too_big @ senses |
| shift | noun, verb | B1 | schema_too_big @ senses |
| shy | adjective | B1 | schema_too_big @ senses |
| slide | noun, verb | B2 | schema_too_big @ senses |
| smooth | adjective | B1 | schema_too_big @ senses |
| steam | noun | B2 | classifier_duplicate @ senses[].meanings_vi[] |
| teens | noun | B2 | too_many_syllables @ senses[].meanings_vi[] |
| terminal | adjective, noun | B2 | schema_too_big @ senses |
| tone | noun | B2 | schema_too_big @ senses |
| trap | noun, verb | B2 | classifier_duplicate @ senses[].meanings_vi[] |

*Lần #8* (21 từ): 2 job `invalid_output`.

Luật mà bản nháp CUỐI (sau một lần sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 2 |

Luật mà câu trả lời ĐẦU TIÊN (trước khi sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 2 |

Theo loại từ (loại từ của hàng có mức CEFR thấp nhất trong file Oxford):

| loại từ | từ đã gửi | từ hỏng | tỉ lệ |
|---|---|---|---|
| noun | 14 | 1 | 7.1% |
| adjective | 6 | 0 | 0.0% |
| adverb | 1 | 1 | 100.0% |

Token ra của các job hỏng: trung vị 4,308 (giới hạn `ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH` mặc định 4.000).

Từng từ:

| từ | loại từ (Oxford) | CEFR | luật vi phạm ở bản cuối |
|---|---|---|---|
| handle | noun, verb | B2 | schema_too_big @ senses |
| overnight | adverb | B2 | schema_too_big @ senses |

*Lần #9* (999 từ): 14 job `invalid_output`.

Luật mà bản nháp CUỐI (sau một lần sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 8 |
| too_many_syllables @ senses[].meanings_vi[] | 2 |
| classifier_duplicate @ senses[].meanings_vi[] | 2 |
| duplicate @ senses[].meanings_vi[] | 1 |
| too_long @ senses[].definition_en | 1 |

Luật mà câu trả lời ĐẦU TIÊN (trước khi sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 8 |
| parenthesis @ senses[].meanings_vi[] | 2 |
| too_many_syllables @ senses[].meanings_vi[] | 2 |
| too_long @ senses[].definition_en | 1 |
| classifier_duplicate @ senses[].meanings_vi[] | 1 |

Theo loại từ (loại từ của hàng có mức CEFR thấp nhất trong file Oxford):

| loại từ | từ đã gửi | từ hỏng | tỉ lệ |
|---|---|---|---|
| noun | 581 | 10 | 1.7% |
| adjective | 221 | 3 | 1.4% |
| verb | 144 | 1 | 0.7% |
| adverb | 53 | 0 | 0.0% |

Token ra của các job hỏng: trung vị 3,991 (giới hạn `ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH` mặc định 4.000).

Từng từ:

| từ | loại từ (Oxford) | CEFR | luật vi phạm ở bản cuối |
|---|---|---|---|
| dam | noun | C1 | classifier_duplicate @ senses[].meanings_vi[] |
| default | noun | C1 | schema_too_big @ senses |
| deficit | noun | C1 | classifier_duplicate @ senses[].meanings_vi[] |
| efficiency | noun | C1 | too_long @ senses[].definition_en |
| extract | noun, verb | B2 | schema_too_big @ senses |
| flame | noun | B2 | schema_too_big @ senses |
| gut | noun | C1 | schema_too_big @ senses |
| hollow | adjective | B2 | schema_too_big @ senses |
| license | verb | C1 | schema_too_big @ senses |
| optimistic | adjective | B2 | duplicate @ senses[].meanings_vi[] |
| socialist | adjective | C1 | too_many_syllables @ senses[].meanings_vi[] |
| tenure | noun | C1 | too_many_syllables @ senses[].meanings_vi[] |
| trail | noun, verb | C1 | schema_too_big @ senses |
| warrant | noun, verb | C1 | schema_too_big @ senses |

*Lần #10* (18 từ): 2 job `invalid_output`.

Luật mà bản nháp CUỐI (sau một lần sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 2 |

Luật mà câu trả lời ĐẦU TIÊN (trước khi sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 2 |

Theo loại từ (loại từ của hàng có mức CEFR thấp nhất trong file Oxford):

| loại từ | từ đã gửi | từ hỏng | tỉ lệ |
|---|---|---|---|
| noun | 11 | 1 | 9.1% |
| adjective | 6 | 1 | 16.7% |
| verb | 1 | 0 | 0.0% |

Token ra của các job hỏng: trung vị 4,178 (giới hạn `ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH` mặc định 4.000).

Từng từ:

| từ | loại từ (Oxford) | CEFR | luật vi phạm ở bản cuối |
|---|---|---|---|
| gut | noun | C1 | schema_too_big @ senses |
| hollow | adjective | B2 | schema_too_big @ senses |

*Lần #11* (440 từ): 2 job `invalid_output`.

Luật mà bản nháp CUỐI (sau một lần sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 1 |
| too_long @ senses[].definition_en | 1 |

Luật mà câu trả lời ĐẦU TIÊN (trước khi sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 1 |
| too_long @ senses[].definition_en | 1 |

Theo loại từ (loại từ của hàng có mức CEFR thấp nhất trong file Oxford):

| loại từ | từ đã gửi | từ hỏng | tỉ lệ |
|---|---|---|---|
| noun | 188 | 1 | 0.5% |
| verb | 174 | 1 | 0.6% |
| adjective | 69 | 0 | 0.0% |
| adverb | 9 | 0 | 0.0% |

Token ra của các job hỏng: trung vị 2,901 (giới hạn `ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH` mặc định 4.000).

Từng từ:

| từ | loại từ (Oxford) | CEFR | luật vi phạm ở bản cuối |
|---|---|---|---|
| drift | verb | C1 | schema_too_big @ senses |
| faction | noun | C1 | too_long @ senses[].definition_en |

*Lần #12* (18 từ): 1 job `invalid_output`.

Luật mà bản nháp CUỐI (sau một lần sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 1 |

Luật mà câu trả lời ĐẦU TIÊN (trước khi sửa) vi phạm, số từ:

| validator @ trường | số từ |
|---|---|
| schema_too_big @ senses | 1 |

Theo loại từ (loại từ của hàng có mức CEFR thấp nhất trong file Oxford):

| loại từ | từ đã gửi | từ hỏng | tỉ lệ |
|---|---|---|---|
| adjective | 10 | 0 | 0.0% |
| noun | 7 | 0 | 0.0% |
| verb | 1 | 1 | 100.0% |

Token ra của các job hỏng: trung vị 3,250 (giới hạn `ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH` mặc định 4.000).

Từng từ:

| từ | loại từ (Oxford) | CEFR | luật vi phạm ở bản cuối |
|---|---|---|---|
| drift | verb | C1 | schema_too_big @ senses |

## 3. Từ bị bỏ qua

**Bị bộ làm sạch đầu vào từ chối (9):** `according to` (nhiều từ), `all right` (nhiều từ), `any more` (nhiều từ), `have to` (nhiều từ), `ice cream` (nhiều từ), `next to` (nhiều từ), `no one` (nhiều từ), `per cent` (nhiều từ), `used to` (nhiều từ)

**Không gửi vì đã có (tính tại thời điểm sinh báo cáo, nên gồm cả mục từ do chính đợt nạp này tạo):** trong từ điển 4,723 · là dạng biến trong word_forms 193 · đang trong hàng đợi 0 · đã có kết quả cuối từ job trước 19.

**Đã gửi nhưng không thành mục từ mới (85), theo job gần nhất của từ:**

| từ | status | reason | số lần chạy |
|---|---|---|---|
| constraint | skipped | exists | 2 |
| convinced | skipped | exists | 1 |
| cooking | skipped | exists | 1 |
| counselling | skipped | lemma_mismatch | 1 |
| covered | skipped | exists | 1 |
| crowded | skipped | exists | 1 |
| dangerous | skipped | exists | 2 |
| determine | skipped | exists | 1 |
| disturbing | skipped | exists | 1 |
| encompass | skipped | exists | 2 |
| engineering | skipped | exists | 1 |
| enquiry | skipped | exists | 1 |
| enrol | skipped | variant_form | 1 |
| evening | skipped | exists | 1 |
| expected | skipped | exists | 1 |
| favour | skipped | variant_form | 1 |
| february | rejected | proper_noun | 1 |
| feeling | skipped | exists | 1 |
| fighting | skipped | exists | 1 |
| film-maker | failed | upstream_error | 4 |
| fit | skipped | exists | 1 |
| fixed | skipped | exists | 1 |
| forth | skipped | variant_form | 1 |
| frighten | skipped | exists | 1 |
| frightening | skipped | exists | 1 |
| funding | skipped | exists | 1 |
| graphics | skipped | exists | 1 |
| half | failed | invalid_output | 1 |
| halt | skipped | variant_form | 1 |
| handle | failed | invalid_output | 1 |
| high-profile | failed | upstream_error | 4 |
| his | skipped | exists | 1 |
| injure | skipped | exists | 1 |
| integrated | skipped | exists | 1 |
| intended | skipped | exists | 1 |
| interested | skipped | exists | 1 |
| interesting | skipped | exists | 1 |
| involved | skipped | exists | 1 |
| its | skipped | exists | 1 |
| july | rejected | proper_noun | 1 |
| killing | skipped | exists | 1 |
| large-scale | failed | upstream_error | 4 |
| leading | skipped | exists | 1 |
| level | failed | invalid_output | 1 |
| licence | skipped | variant_form | 1 |
| line-up | failed | upstream_error | 4 |
| long-standing | failed | upstream_error | 4 |
| long-time | failed | upstream_error | 4 |
| make-up | failed | upstream_error | 4 |
| meaning | skipped | exists | 1 |
| meeting | skipped | exists | 1 |
| my | skipped | exists | 1 |
| news | skipped | exists | 1 |
| non-profit | failed | upstream_error | 4 |
| old-fashioned | failed | upstream_error | 4 |
| ought | skipped | variant_form | 1 |
| our | skipped | exists | 1 |
| out | failed | invalid_output | 1 |
| outdoors | skipped | exists | 1 |
| part-time | failed | upstream_error | 4 |
| post-war | failed | upstream_error | 4 |
| reading | skipped | exists | 1 |
| recording | skipped | exists | 1 |
| relieve | skipped | exists | 1 |
| sailing | skipped | exists | 1 |
| sceptical | skipped | variant_form | 1 |
| set-up | failed | upstream_error | 4 |
| shocked | skipped | exists | 1 |
| singing | skipped | exists | 1 |
| skiing | skipped | exists | 1 |
| smoking | skipped | exists | 1 |
| so-called | failed | upstream_error | 4 |
| span | skipped | exists | 1 |
| specialized | skipped | exists | 1 |
| spelling | skipped | exists | 1 |
| surprised | skipped | exists | 1 |
| surprising | skipped | exists | 1 |
| them | skipped | exists | 1 |
| themselves | skipped | exists | 1 |
| they | skipped | exists | 1 |
| thought-provoking | failed | upstream_error | 4 |
| washing | skipped | exists | 1 |
| worried | skipped | exists | 1 |
| would | skipped | exists | 1 |
| you | failed | invalid_output | 1 |

## 4. Token và chi phí: thực so với ước tính

| nguồn | token vào | token ra | chi phí ước tính | ghi chú |
|---|---|---|---|---|
| hàng word_enrichment_jobs của các từ đã gửi | 40,663,368 | 6,122,165 | $4.28 | 4,026 job có gọi Haiku; chỉ lưu token của lần chạy cuối của mỗi job |
| bộ đếm api_usage_counters, mức tăng từ trước lần gửi đầu | 40,824,296 | 6,145,425 | $4.31 | MỌI lần gọi Haiku trong thời gian đó, kể cả lần thử lại (và việc khác dùng Haiku cùng lúc, nếu có) |
| ước tính trước khi gửi (dry-run) | - | - | $5.98 | 5,105 từ; nguồn: history, history, history, history, history, history, history, history, history, history, history, history, history, history |

Lần thử lại và lần gọi bị mất ở hàng sổ làm chênh lệch: bộ đếm cao hơn hàng sổ $0.0277. Chi phí thực tính cả lần thử lại: **$4.31** ($0.0011 mỗi job có gọi Haiku). Bảng giá là nhập tay (`services/enrichment/pricing.ts`) và giả định 7,859 token system prompt đọc từ cache mỗi job: hóa đơn của Anthropic mới là số chính xác.

Chi phí thực bằng 0.72 lần ước tính (dừng khẩn cấp khi vượt 2 lần) — đạt.

Số lần chạy mỗi từ: trung bình 1.05 (theo hàng sổ); phân bố 1 lần: 3,929, 2 lần: 31, 3 lần: 2, 4 lần: 14.

## 5. Thời gian

Từ lúc bắt đầu gửi đến job xong cuối cùng: 84.3 giờ cho 3,976 từ.
Từ lúc job được tạo đến lúc xong (gồm thời gian chờ trong hàng đợi): trung vị 976.6 giây, p95 8430.3 giây.

Theo log của worker (`oxford-seed-all-worker.log`, 4,089 dòng `enrich`): thời gian chạy MỘT job trung vị 8.6 giây, p95 18.3 giây, lâu nhất 87.2 giây; lần gọi Haiku trung bình 7.6 giây; dòng `enrich_retry`: 199; theo lần chạy lần 1: 4,053, lần 2: 34, lần 3: 2.

## 6. Phân bố CEFR: Oxford so với Haiku

```
Haiku (hàng) so với Oxford (cột), 3880 mục từ có mức Oxford:
            A1   A2   B1   B2   C1   tổng
  A1       278    8    0    0    0    286
  A2       290  132   24   12    2    460
  B1       125  353  243  157   34    912
  B2        12  106  263  769  573   1723
  C1         0    0    2   97  400    499
  trùng 1822 (47%) · lệch 1 bậc 1765 · lệch từ 2 bậc 293 · Haiku không đề xuất 0
  Haiku khó hơn Oxford 1248 · dễ hơn 810
```

Mức CEFR đã được áp theo Oxford (`npm run oxford:apply-cefr`) cho 0/3,881 mục từ; phần còn lại vẫn mang mức Haiku ước tính. Cột "Haiku" của mục đã áp được đọc lại từ `entry_edit_history`.

## 7. Phân bố chủ đề

| chủ đề | số mục từ |
|---|---|
| core_language | 1205 |
| politics_law | 683 |
| business_economy | 464 |
| psychology_mind | 452 |
| arts_entertainment | 400 |
| work_career | 378 |
| media_communication | 367 |
| science_research | 296 |
| character_values | 290 |
| health_medicine | 268 |
| emotions_feelings | 253 |
| technology_digital | 253 |
| geography_places | 229 |
| time_calendar | 224 |
| environment_society | 213 |
| transport_travel | 175 |
| sports_recreation | 164 |
| home_household | 157 |
| plants_nature | 151 |
| education_school | 142 |
| shopping_commerce | 142 |
| food_drink | 127 |
| body_appearance | 99 |
| family_relationships | 80 |
| greetings_social | 79 |
| weather_climate | 77 |
| animals_wildlife | 71 |
| clothes_fashion | 64 |
| colors_shapes | 46 |
| academic_formal | 4 |

3,891/3,891 mục từ có ít nhất một chủ đề; 0 mục không có chủ đề nào.

## 8. Mục thiếu IPA, audio, ví dụ; nghĩa và ghi chú

| chỉ tiêu | số mục từ | trên 3891 |
|---|---|---|
| thiếu cả ipa_us và ipa_uk | 51 |  |
| thiếu ipa_us | 147 |  |
| thiếu cả audio_us_url và audio_uk_url | 105 |  |
| không có ví dụ nào | 0 |  |
| không có chủ đề | (mục 7) |  |
| đã xuất bản (published) | 23 |  |

Số nghĩa (sense) trung bình: 3.78; số nghĩa tiếng Việt (tách `definition_vi` bằng ";") trung bình: 8.13.

Mục từ có `notes_for_review` của Haiku: 3,891/3,891; trong đó 1,969 có ghi chú thuộc nhóm "cần xem" (chặn xuất bản hàng loạt). Theo nhóm: Nghĩa đã bỏ có chủ ý 5,256, CEFR ước tính 2,220, Thẻ đã bị bộ kiểm tra bỏ 1,251, Nghĩa gần nhau đã gộp 949, Bộ kiểm tra của job báo lỗi 945, Nghi ngờ nghĩa 928, Còn lại (không nhận ra) 714, Ghi chú về dữ liệu nguồn 583, Gợi ý biên tập 334, Giải thích điều đã giữ hay đã ghi 226, Lưu ý nhẹ về cách dùng 213, Từ nhạy cảm hoặc thô tục 176, Tên riêng 35.

## 9. Dung lượng cơ sở dữ liệu

|  | trước lần gửi đầu | bây giờ | tăng |
|---|---|---|---|
| toàn cơ sở dữ liệu (pg_database_size) | 251.10 MB | 290.10 MB | 39.00 MB |
| các bảng bị ghi (17, gồm chỉ mục và TOAST) | 6.07 MB | 43.16 MB | 37.09 MB |

Dung lượng trên đĩa gần như không đổi khi hàng mới dùng lại chỗ trống do các hàng đã xóa để lại (cơ sở dữ liệu vừa được dọn 38 mục từ), nên con số dưới đây mới là con số co giãn được: tổng kích thước DỮ LIỆU của các hàng thuộc những mục từ mới (chưa tính chỉ mục).

Dữ liệu của 3,891 mục từ mới: 20.04 MB (trung bình 5.3 KB mỗi mục từ). Với 14 từ còn có thể gửi, dự kiến thêm khoảng 0.07 MB dữ liệu, chưa tính chỉ mục. Theo bảng: dictionary_entries 6,209, sense_examples 3,889, entry_senses 3,760, sense_synonyms 1,405, entry_answer_aliases 1,184, word_forms 1,143 (KB).

## 10. 30 từ ngẫu nhiên kèm nghĩa

| từ | loại từ | CEFR | nghĩa (meaning_vi) |
|---|---|---|---|
| evil | adjective, noun | B2 | độc ác; khó chịu; cái ác; tai họa; xấu xa; tồi tệ |
| painter | noun | B1 | họa sĩ; thợ sơn; người vẽ tranh; thợ quét sơn |
| distance | noun, verb | B1 | khoảng cách; khoảng thời gian; sự xa cách; đặt xa; bỏ xa; tách mình ra |
| shower | noun, verb | B1 | cơn mưa rào; vòi hoa sen; mưa; tiệc tặng quà; tắm vòi sen; tặng dồi dào |
| vacation | noun, verb | A2 | kỳ nghỉ; kỳ nghỉ chính thức; sự rời khỏi; đi nghỉ; chuyến đi nghỉ; kỳ nghỉ học |
| gentle | adjective, verb, noun | B2 | hiền hậu; nhẹ nhàng; thuần, dễ bảo; thoai thoải; làm dịu; sâu mồi câu |
| mount | noun, verb | B2 | ngọn núi; leo lên; cưỡi; tăng dần; ngựa cưỡi; giá đỡ |
| proposition | noun, verb | B2 | đề xuất; dự luật trưng cầu; mệnh đề; gạ gẫm; kiến nghị; đề án bỏ phiếu |
| poison | noun, verb | B2 | chất độc; mối hại; rượu; đầu độc; làm ô nhiễm; làm hỏng |
| meditation | noun | B2 | thiền; bài suy ngẫm; suy ngẫm; thiền định; tiểu luận triết lý; trầm tư |
| storm | noun, verb | B1 | bão; trận mưa lớn; cuộc tấn công ồ ạt; xông vào; xông vào tấn công; cơn bão |
| tear | verb, noun | B2 | xé; làm rách; giật mạnh; vết rách; giọt nước mắt; làm đứt |
| huge | adjective | B1 | khổng lồ; mạnh mẽ; nổi tiếng; rất lớn; lớn lao; thành công rực rỡ |
| mainland | noun | B2 | đất liền; đảo chính; đảo Great Britain; lục địa; đất liền Anh |
| injection | noun | B2 | tiêm; mẫu tiêm; bơm ép; vốn rót vào; mũi tiêm; phun vữa |
| critique | noun, verb | C1 | bài phê bình; lời chỉ trích; nghệ thuật phê bình; phê bình; bài bình luận; nhận xét phê phán |
| eligible | adjective, noun | B2 | đủ điều kiện; đáng kết hôn; người đủ điều kiện; có quyền tham gia; giàu có, danh giá; ứng viên hợp lệ |
| plain | adjective, noun, adverb | B1 | đơn giản; rõ ràng; không đẹp; đồng bằng; hoàn toàn; mộc mạc |
| October | noun | A1 | tháng mười |
| concrete | adjective, noun, verb | B2 | cụ thể; bê tông; phủ bê tông; thực tế; rõ ràng; đổ bê tông |
| lifestyle | noun | B1 | lối sống; phong cách tiêu dùng; phong cách sống; thị hiếu tiêu dùng |
| union | noun, adjective | B2 | sự hợp nhất; sự đoàn kết; công đoàn; thuộc công đoàn; sự kết hợp; sự hòa hợp |
| controversy | noun | B2 | tranh cãi; tranh luận gay gắt; bất đồng |
| prize | noun, verb, adjective | B1 | giải thưởng; chiến lợi phẩm; mục tiêu quý giá; quý trọng; cạy; đoạt giải |
| overcome | verb, adjective | B2 | vượt qua; đánh bại; áp đảo; bị áp đảo; khắc phục; chiến thắng |
| teens | noun | B1 | tuổi thiếu niên; số từ 13 đến 19; thập niên thứ hai; tuổi teen; khoảng từ 13 đến 19; những năm 10 |
| pole | noun, verb | B1 | cột; cực; thái cực; chống sào; cọc; địa cực |
| furniture | noun | A2 | đồ đạc; yên cương; phụ kiện; nội thất; bộ yên ngựa; đồ kim loại gắn |
| fourth | adjective, noun, verb | A2 | thứ tư; một phần tư; người thứ tư; tán thành sau người thứ ba; vật thứ tư |
| stall | noun, verb | B2 | quầy hàng; chuồng ngựa; sự trì hoãn; sự chết máy; chết máy; câu giờ |

## 10b. 30 mục ngẫu nhiên ĐỦ ĐIỀU KIỆN xuất bản (tiêu chí của nút xuất bản hàng loạt)

1,902/3,868 mục từ mới còn chờ duyệt đủ điều kiện (đủ tầng A, không có ghi chú "cần xem"); giữ lại 1,966 mục, một mục có thể có nhiều lý do: Nghi ngờ nghĩa 866, Bộ kiểm tra của job báo lỗi 715, Còn lại (không nhận ra) 668, Từ nhạy cảm hoặc thô tục 162, Tên riêng 35. 23 mục đã được xuất bản bằng tay ở giao diện (không phải do công cụ này) và không tính ở đây.

| từ | loại từ | CEFR | các nghĩa tiếng Việt (mỗi sense một nhóm) |
|---|---|---|---|
| festival | noun | B1 | (noun) lễ hội; ngày hội; ngày lễ · (noun) liên hoan; hội diễn; festival · (noun) lễ hội thần thoại; lễ tế thần |
| tale | noun, verb | B2 | (noun) câu chuyện; truyện kể; chuyện · (noun) lời đồn; chuyện bịa; lời nói dối · (verb) kể chuyện; nói chuyện |
| supervision | noun | C1 | (noun) sự giám sát; sự quản lý · (noun) sự giám sát an toàn; sự kiểm soát · (noun) buổi hướng dẫn; buổi tư vấn học thuật |
| nobody | pronoun, noun | A2 | (pronoun) không ai; chẳng ai · (noun) kẻ vô danh; người chẳng ra gì |
| crude | adjective, noun | C1 | (adjective) thô; chưa tinh chế; nguyên chất · (adjective) thô sơ; sơ sài; kém tinh xảo · (adjective) thô lỗ; thiếu tế nhị; tục tĩu · (noun) dầu thô |
| edit | noun, verb | B2 | (noun) chỉnh sửa; sửa đổi · (noun) bản dựng; bản cắt ghép · (verb) biên tập; chỉnh sửa · (verb) cắt ghép; dựng phim · (verb) biên tập; làm chủ biên · (verb) chỉnh sửa; cập nhật |
| risk | noun, verb | B1 | (noun) rủi ro; nguy cơ · (noun) mối nguy; yếu tố rủi ro · (verb) mạo hiểm; liều; đánh cược |
| spill | verb, noun | B1 | (verb) làm đổ; làm vung vãi · (verb) tràn ra; chảy ra · (verb) tràn ra; đổ ra · (noun) chỗ đổ; vết đổ · (noun) cú ngã; cú té |
| prescription | noun | B2 | (noun) đơn thuốc; toa thuốc; đơn kê · (noun) thuốc theo đơn; thuốc kê toa · (noun) phương thuốc; giải pháp; công thức · (noun) sự ban hành; sự quy định · (noun) sự quy định chuẩn mực · (noun) thời hiệu |
| vocal | adjective, noun | C1 | (adjective) thuộc giọng nói; bằng giọng nói; về âm thanh · (adjective) thẳng thắn; lớn tiếng; công khai · (noun) phần hát; giọng hát |
| tunnel | noun, verb | B1 | (noun) đường hầm; hầm · (noun) hang; ụ · (verb) đào hầm; khoét đường hầm |
| organize | verb | B2 | (verb) sắp xếp; tổ chức; bố trí · (verb) tổ chức; lên kế hoạch; điều phối · (verb) tổ chức công đoàn; liên kết |
| lend | verb | B1 | (verb) cho mượn; cho vay · (verb) cho vay · (verb) phù hợp với; thích hợp cho |
| moderate | adjective, noun, verb | B2 | (adjective) vừa phải; điều độ; chừng mực · (adjective) trung bình; tầm trung · (adjective) ôn hòa; nhẹ nhàng · (noun) người ôn hòa; người theo phái ôn hòa · (verb) làm dịu; giảm bớt; điều tiết |
| nerve | noun, verb | B2 | (noun) dây thần kinh · (noun) gan dạ; sự táo bạo; sự trơ tráo · (noun) sự bình tĩnh; sự kiên nhẫn · (noun) sự lo lắng; sự căng thẳng · (verb) tiếp thêm can đảm; tiếp thêm sức mạnh |
| self | noun, pronoun, verb, adjective | B1 | (noun) bản thân; bản chất; tính cách · (noun) cái tôi; bản ngã · (pronoun) chính nó; chính anh ấy; chính cô ấy · (verb) tự thụ phấn; giao phối cận huyết · (adjective) đơn sắc; thuần chất |
| founder | noun, verb | B2 | (noun) người sáng lập; người thành lập · (verb) chìm; đắm · (verb) thất bại; sụp đổ · (verb) vấp ngã; què |
| fantastic | adjective | B1 | (adjective) tuyệt vời; tuyệt diệu · (adjective) hoang đường; viển vông · (adjective) viển vông; phi thực tế |
| mountain | noun | A2 | (noun) núi; ngọn núi · (noun) núi; đống lớn · (noun) thử thách lớn; việc khó khăn |
| resolution | noun | C1 | (noun) quyết định; nghị quyết · (noun) quyết tâm; kiên quyết · (noun) lời hứa quyết tâm; quyết định cá nhân · (noun) độ phân giải · (noun) độ phân giải; số điểm ảnh |
| whoever | pronoun | B2 | (pronoun) bất cứ ai; ai; người nào · (pronoun) rốt cuộc là ai; ai thế nhỉ |
| congregation | noun | C1 | (noun) hội chúng; giáo đoàn; tín đồ · (noun) đám đông; cuộc tụ họp · (noun) đàn chim tụ họp |
| suddenly | adverb | B1 | (adverb) đột ngột; bỗng nhiên; bất ngờ |
| pass | verb, noun | B1 | (verb) đi qua; vượt qua; đi ngang qua · (verb) đưa; chuyển · (verb) thi đỗ; qua môn · (noun) đèo; hẻm núi · (noun) giấy thông hành; thẻ ra vào |
| descent | noun | B2 | (noun) sự đi xuống; sự hạ xuống; sự xuống dốc · (noun) lối xuống; đường dốc xuống · (noun) dòng dõi; gốc gác; nguồn gốc tổ tiên · (noun) sự suy giảm; sự sa sút; sự đi xuống |
| superior | adjective, noun | B2 | (adjective) cao cấp; vượt trội; ưu việt · (adjective) không hề nao núng; bất khuất · (noun) cấp trên; người bề trên |
| partner | noun, verb | B1 | (noun) đối tác; bạn đồng hành; bạn nhảy · (noun) bạn đời; người yêu; vợ chồng · (verb) hợp tác; cộng tác; kết đối tác |
| landlord | noun, verb | B1 | (noun) chủ nhà; chủ cho thuê · (noun) chủ quán rượu · (verb) cho thuê |
| trust | noun, verb | B1 | (noun) niềm tin; sự tin cậy; lòng tin · (noun) sự mua chịu; tín dụng · (noun) quỹ ủy thác; tài sản ủy thác · (verb) tin tưởng; tin cậy · (verb) tin rằng; mong rằng |
| interval | noun | B2 | (noun) khoảng thời gian; quãng thời gian · (noun) khoảng cách; quãng cách · (noun) quãng nhạc; khoảng cách âm · (noun) giờ nghỉ giữa; màn nghỉ |

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

### mud  _(noun, verb · B2 · chờ duyệt)_

- IPA: /mʌd/ / - · audio: có · `meaning_vi`: bùn; làm bẩn bùn; bùn lầy; phủ bùn
- (noun) A wet mixture of water and soil or fine earth that becomes soft and sticky. → **bùn; bùn lầy**
  - The children came home covered in mud after playing in the rain. — Bọn trẻ về nhà dính đầy bùn sau khi chơi dưới mưa.
- (verb) To make something dirty or muddy, or to cover something with mud. → **làm bẩn bùn; phủ bùn**
  - The heavy truck mudded the road after the storm. — Chiếc xe tải nặng làm bẩn cả con đường sau cơn bão.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: d062838b-51e1-4c49-9a6c-aa28e3e3eea7 · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=B2 · [ipa-untagged] ipa_us lấy từ IPA đầu tiên không gắn thẻ giọng của Wiktionary, không rõ giọng · ghi chú của Haiku: Nghĩa 'vữa trát tường' và 'bê tông

### tonne  _(noun · B2 · chờ duyệt)_

- IPA: - / /tʌn/ · audio: có · `meaning_vi`: tấn; tấn mét
- (noun) A unit of mass equal to 1000 kilograms, used for measuring heavy weights such as cargo. → **tấn; tấn mét**
  - The ship can carry up to 500 tonnes of cargo. — Con tàu có thể chở tối đa 500 tấn hàng hóa.
  - Global steel production reached over 1,800 million tonnes last year. — Sản lượng thép toàn cầu đạt hơn 1.800 triệu tấn năm ngoái.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: c1f120a0-eda8-4162-a141-de67de27333e · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=B2 · ghi chú của Haiku: Mục 'Tonne' là họ người Đức (tên riêng) nên không lập nội dung; chỉ lập mục cho danh từ chung. | Dữ liệu nguồn chỉ có một nghĩa; 

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

### democratic  _(adjective, noun · B2 · chờ duyệt)_

- IPA: /ˌdɛməˈkɹætɪk/ / /ˌdɛməˈkɹætɪk/ · audio: có · `meaning_vi`: dân chủ; bình đẳng; thuộc Đảng Dân chủ; người ủng hộ dân chủ; thuộc về dân chủ
- (adjective) Relating to democracy; based on or in line with government chosen by the people. → **dân chủ; thuộc về dân chủ**
  - The country adopted a democratic system after the election. — Đất nước đã áp dụng hệ thống dân chủ sau cuộc bầu cử.
- (adjective) Showing social equality; treating everyone as equal, without privilege. → **bình đẳng; dân chủ**
  - She has a democratic style of leadership that values everyone's opinion. — Cô ấy có phong cách lãnh đạo dân chủ, coi trọng ý kiến của mọi người.
- (adjective) Of or relating to the Democratic Party of the United States. → **thuộc Đảng Dân chủ**
  - He was elected as a Democratic senator from California. — Ông được bầu làm thượng nghị sĩ Đảng Dân chủ đến từ California.
- (noun) A supporter or advocate of democracy or democratic politics. → **người ủng hộ dân chủ**
  - The democratics demanded a greater voice for ordinary citizens. — Những người ủng hộ dân chủ đòi hỏi tiếng nói lớn hơn cho người dân thường.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: b185175c-ed43-46bf-a08b-e357fef1e1fd · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · thiếu tầng B: is_countable · ước tính: cefr_level=B2 · ghi chú của Haiku: Nghĩa 3 (Đảng Dân chủ Mỹ) là nghĩa viết hoa, được tách riêng; cân nhắc thêm nếu cần. | Nghĩa 4 (danh

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

### highly  _(adverb · B2 · chờ duyệt)_

- IPA: /ˈhaɪli/ / - · audio: có · `meaning_vi`: đánh giá cao; rất; khen ngợi; vô cùng; cực kỳ
- (adverb) In a way that shows high respect or approval; favourably. → **đánh giá cao; khen ngợi**
  - She spoke highly of her former teacher. — Cô ấy đánh giá rất cao người thầy cũ của mình.
  - He is highly regarded by his colleagues. — Anh ấy được đồng nghiệp đánh giá rất cao.
- (adverb) To a great degree; extremely or very much. → **rất; vô cùng; cực kỳ**
  - The results of the experiment were highly significant. — Kết quả thí nghiệm có ý nghĩa rất lớn.
  - The job requires highly specialised skills. — Công việc này đòi hỏi kỹ năng chuyên môn cao.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: da38aa99-7275-4ee1-b5f0-847a8cf5a073 · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=B2 · [ipa-untagged] ipa_us lấy từ IPA đầu tiên không gắn thẻ giọng của Wiktionary, không rõ giọng · ghi chú của Haiku: Đã rút gọn sense 'highly visible/c

### terminal  _(noun, adjective · B2 · chờ duyệt)_

- IPA: /ˈtɝmɪnəl/ / /ˈtɜːmɪnəl/ · audio: có · `meaning_vi`: nhà ga; bến cuối; kho chứa; đầu cực; nan y; cuối cùng
- (noun) A building at an airport where passengers go to get on or off airplanes. → **nhà ga; ga sân bay**
  - Terminal 1 is for domestic flights, and Terminal 2 is for international flights. — Nhà ga số 1 dành cho chuyến bay nội địa, còn nhà ga số 2 dành cho chuyến bay quốc tế.
- (noun) A station at the end of a railway line, or a place where ferries or buses start and finish their routes. → **bến cuối; ga cuối**
  - The train goes to the terminal at the end of the line. — Tàu chạy đến ga cuối của tuyến.
- (noun) A storage facility where oil or chemicals are kept before being distributed. → **kho chứa; bể chứa**
  - The oil is stored in a large terminal near the port. — Dầu được chứa trong một kho lớn gần cảng.
- (noun) The point where a wire or cable ends and signals or power are connected to a device. → **đầu cực; đầu nối**
  - Connect the red wire to the positive terminal of the battery. — Nối dây đỏ với cực dương của pin.
- (adjective) Causing death; certain to end in death, especially of a disease. → **nan y; không thể chữa**
  - He was diagnosed with terminal cancer last year. — Năm ngoái ông được chẩn đoán mắc ung thư giai đoạn cuối.
- (adjective) Happening at the end of something, such as a period of time or a series. → **cuối cùng; ở cuối**
  - The terminal stage of the project was the most difficult. — Giai đoạn cuối cùng của dự án là khó khăn nhất.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: 80ca0e85-9b71-48d7-9ec5-c5b429304c6c · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=B2 · loại từ của Wiktionary không có trong mục: verb · ghi chú của Haiku: Đã gộp sense máy trạm (computer terminal) vào sense thiết bị đầu cuối để giới h

### resemble  _(verb · B2 · chờ duyệt)_

- IPA: /ɹɪˈzɛmbəl/ / /ɹɪˈzɛmbəl/ · audio: có · `meaning_vi`: giống; na ná; mang nét giống
- (verb) To be like or similar to someone or something in appearance or qualities. → **giống; na ná; mang nét giống**
  - The twins resemble each other so closely that even their teachers confuse them. — Hai anh em sinh đôi giống nhau đến mức ngay cả giáo viên cũng nhầm lẫn.
  - The new building resembles a large ship floating above the city streets. — Tòa nhà mới trông giống một con tàu lớn lơ lửng trên các con phố thành phố.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, haiku · model: claude-haiku-5-5 · job: 0f58550e-336a-4d80-97d7-a5ea3c91fe1f · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=B2 · ghi chú của Haiku: Dữ liệu nguồn có nhiều nghĩa cổ hoặc lỗi thời (liken, counterfeit, cause to imitate) đã bỏ qua vì không phổ biến với người học hiện đại. | Chỉ ghi một sense vì các ngh

### mask  _(noun, verb · B2 · chờ duyệt)_

- IPA: /mæsk/ / /mɑːsk/ · audio: có · `meaning_vi`: mặt nạ; vỏ bọc; che phủ; che giấu; khẩu trang; lớp che đậy
- (noun) A covering for all or part of the face, worn for disguise or protection. → **mặt nạ; khẩu trang**
  - The dancer wore a painted mask during the performance. — Vũ công đeo một chiếc mặt nạ sơn màu trong suốt buổi biểu diễn.
  - Doctors wear a mask to protect themselves from infection. — Bác sĩ đeo khẩu trang để tự bảo vệ khỏi lây nhiễm.
- (noun) Something that hides the true nature of a situation or person. → **vỏ bọc; lớp che đậy**
  - His cheerful manner was just a mask for his deep anxiety. — Vẻ vui vẻ của anh ấy chỉ là lớp vỏ bọc cho nỗi lo sâu sắc bên trong.
- (verb) To cover the face or something else to hide identity or give protection. → **che phủ; đeo mặt nạ**
  - The robbers masked their faces before entering the bank. — Bọn cướp che mặt trước khi vào ngân hàng.
- (verb) To hide something from view or from knowledge. → **che giấu; che đậy**
  - She masked her disappointment with a polite smile. — Cô ấy che giấu sự thất vọng bằng một nụ cười lịch sự.
- admin_note: [auto] nguồn: wiktionary, ref_word_frequency, datamuse (chỉ là ứng viên của Haiku), haiku · model: claude-haiku-5-5 · job: 0853c2ec-f8e4-49cf-8367-bb1d987e63e6 · published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review) · ước tính: cefr_level=B2 · ghi chú của Haiku: Các nghĩa kỹ thuật cổ hoặc phương ngữ (mesh, mash, bewilder, brewing) đã bỏ qua vì không phổ biến với người học. | Nghĩa poetic '

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

Khi viết ghi chú này, phần sinh tự động ở trên (`--report --from-run 2`) chỉ nói về giai đoạn 2 (lần gửi #2 và #3). Sau giai đoạn 3 phần đó được sinh lại cho **mọi lần gửi** (`--from-run 1`, #1 đến #12); số liệu riêng của từng giai đoạn nằm ở các ghi chú viết tay này.

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

**Giai đoạn 2 dừng ở đây (đã duyệt); giai đoạn 3 ở ghi chú bên dưới.**

### Giai đoạn 3: phần còn lại, 4 lô (22–23/10/2026)

Phần sinh tự động ở trên nay là số liệu **tích lũy** của cả ba giai đoạn (lần gửi #1 đến #12: #4 đến #12 là giai đoạn 3).

* **Cách chạy.** Mỗi lệnh gửi tối đa 1000 từ (`--limit 1000 --confirm`), `ENRICHMENT_ENABLED=true`, `ENRICHMENT_PUBLISH_POLICY=review`, `ENRICHMENT_MAX_JOBS_PER_DAY` đặt riêng cho từng lệnh (số đã dùng hôm nay + lô + dư), `ENRICHMENT_WORKER_CONCURRENCY=2` ở lô 1 và 4 ở lô 2 đến 4; không sửa `.env`. Sau mỗi lô: một lượt `--retry-last-run` (chạy thử, rồi `--confirm`) cho các từ chưa thành mục từ, rồi tắt worker bằng Ctrl-C (`shutdown_start SIGINT`, kết thúc gọn, không dùng `taskkill` cho worker). Cột "đồng thời" của bảng lần gửi ở mục 1 ghi 2 cho mọi dòng vì nó ghi biến của **lệnh gửi** (không đặt), không phải của worker.
* **Bốn lô.**

| lô | lần gửi | từ (lượt đầu) | mục từ mới | `invalid_output` lượt đầu | gửi lại | chi phí hàng sổ | so với ước tính |
|---|---|---|---|---|---|---|---|
| 1 (A1, A2, B1) | #4, #5, #6 | 996 | 965 | 27 (2,7%) | 27 từ → 19 qua | $1,128 | 0,87× |
| 2 (B1, B2) | #7, #8 | 998 | 984 | 20 (2,0%) | 21 từ → 18 qua | $1,034 | 0,85× |
| 3 (B2, C1) | #9, #10 | 999 | 984 | 14 (1,4%) | 18 từ → 12 qua | $0,935 | 0,83× |
| 4 (C1, còn lại) | #11, #12 | 440 | 418 | 2 (0,5%) | 18 từ → 1 qua | $0,350 | 0,74× |

  Giai đoạn 3 tạo **3.351 mục từ mới** (tất cả `published = false` do công cụ này), tổng **$3,45** theo hàng sổ (khoảng $0,00103 mỗi mục từ). Cả ba chỉ số dừng khẩn cấp đều đạt ở mọi lô: `invalid_output` lượt đầu tối đa 2,7% (ngưỡng 8%), không có một lỗi 429 hay hết ngân sách nào, chi phí trung bình luôn dưới ước tính.
* **Kết quả cuối của cả đợt nạp (4.949 từ hợp lệ của Oxford).** 4.704 từ đã có mục từ (gồm các mục do đợt này tạo), 193 là dạng biến trong `word_forms`, 36 đã có kết quả cuối từ job trước, **16 từ chưa nạp được** (có dấu gạch nối, xem dưới); 4.704 + 193 + 36 + 16 = 4.949. Trong 36 từ đó: `failed / invalid_output` 22 (`drift flat function gut half handle help hit hollow hope into level opposite out overnight plus right slow underground warm welcome you`), `skipped / variant_form` 7 (`enrol favour forth halt licence ought sceptical`, phần lớn là chính tả Anh của từ Mỹ đã có), `skipped / lemma_mismatch` 1 (`counselling`), `rejected / proper_noun` 2 (`february`, `july`), và 4 từ có job đã ra mục từ nhưng dưới chính tả khác (`judgement`, `enquiry`…). Ngoài ra có 56 job `skipped / exists` ở mọi lần gửi: đó **không phải lỗi**, các dạng chia như `spelling`, `cooking`, `worried` đã thành `word_forms` của mục từ tạo cùng đợt nên S0 thấy "đã có".
* **`invalid_output` theo nguyên nhân.** Lượt đầu của giai đoạn 2 và 3 cộng lại: bản nháp cuối vi phạm `schema_too_big @ senses` (hơn 6 sense) ở 69 trên 91 từ (76%), rồi `classifier_duplicate` (11), `too_many_syllables` (5), `too_long`, `parenthesis`, `duplicate` (mỗi loại 1 đến 3). Gần như mọi từ hỏng hai lần đều là từ rất nhiều nghĩa (`out`, `right`, `help`, `hit`, `level`, `flat`, `function`, `warm`…): lượt gửi lại chỉ cứu thêm các từ mà lần đầu Haiku lệch nhẹ. Theo loại từ tỉ lệ hỏng lượt đầu đồng đều (danh từ 0,5 đến 2,7% tùy lô, tính từ 0 đến 3,6%, động từ 0 đến 2,8%, trạng từ 0 đến 1,5%); giai đoạn 1 và 2 (500 từ A1 thông dụng nhất) khó hơn nhiều vì từ càng thông dụng càng nhiều nghĩa.
* **16 từ có dấu gạch nối không nạp được.** `old-fashioned make-up part-time so-called decision-making film-maker high-profile large-scale line-up long-standing long-time non-profit post-war set-up thought-provoking well-being`: Free Dictionary trả **HTTP 530** nên job `failed / upstream_error` sau 4 lần chạy, không tốn token. **Nhận định ban đầu "mọi từ có dấu gạch nối đều 530" là sai**, đã sửa ở giai đoạn 4 bên dưới (2 trong 16 từ, `well-being` và `decision-making`, nạp được; nguyên nhân thật là Free Dictionary trả 530 cho từ nó không có).
* **Sự cố trong lúc làm.**
  1. 22/10 04:22, lô 1: mạng rơi (`ECONNRESET`, rồi DNS `ENOTFOUND`) và từ kế tiếp của lệnh gửi treo mãi. Tôi tắt đúng chuỗi tiến trình `seed-oxford` của mình (một `taskkill` theo PID, nói rõ lúc đó), dựng lại bản ghi lần gửi #4 (7 từ) từ log gửi và bảng job, rồi tiếp tục bằng lần #5. Từ `dear` bị `queue_error` đúng lúc đó đã qua ở lần sau.
  2. 22/10 06:21 đến 08:10, lô 2: cả bốn slot của worker đứng **1 giờ 50 phút** vì một kết nối Neon chết âm thầm (mặc định keep-alive của Windows khoảng 2 giờ). Không mất job (hết hạn rồi được pg-boss xếp lại).
  3. 22/10 09:56 đến 23/10 17:10, lô 4: không job nào xong trong **31 giờ**, nhiều khả năng máy ngủ; khi máy dậy worker tự chạy tiếp, không mất job.
  4. 154 dòng `enrich_retry` trong các log worker, hầu hết `[anthropic] connection error` thoáng qua, đều được thử lại thành công (số lần chạy mỗi từ: trung bình 1,04).
* **Thay đổi công cụ trong giai đoạn 3** (đều có test): (a) lệnh gửi có hạn 45 giây mỗi từ, thử lại lỗi mạng thoáng qua tối đa 2 lần, dừng sau 3 lỗi liên tiếp, và ghi tệp trạng thái trước khi gửi rồi cứ 10 từ; (b) TCP keep-alive cho mọi pool PostgreSQL (`config/keepAlive.ts`, gồm cả pool riêng của pg-boss); (c) kiểm tra "đúng một worker" chỉ đếm tên `enrichment-worker`, không đếm `enrichment-sender` của máy chủ đã triển khai (trước đó từng báo nhầm "hai worker lạ"); (d) job `succeeded` / `skipped exists` mà mục từ của nó còn tồn tại thì từ coi như xong, kể cả khi Haiku lưu dưới chính tả khác (`judgement` → `judgment`), trước đó các từ này bị gửi lại vô ích; (e) mục 10b chỉ tính mục còn chờ duyệt và ghi số mục đã được admin xuất bản bằng tay; (f) log worker ghi `issues` / `first_issues` cho `invalid_output` (làm ở giai đoạn 1 và dùng ở đây); (g) sửa hai lỗi trong test phụ thuộc dữ liệu (đếm job có dấu phân cách hàng nghìn, ngày giả định).
* **Chất lượng nội dung.** 3.872 mục từ mới đều có ít nhất một chủ đề và ít nhất một ví dụ; trung bình 3,78 sense và 8,12 nghĩa tiếng Việt mỗi mục; thiếu cả hai IPA ở 49 mục, thiếu `ipa_us` ở 144 mục, thiếu cả hai audio ở 103 mục (IPA và audio của Oxford **không** được dùng, theo yêu cầu). Mọi mục đều có `notes_for_review`; **1.894/3.849** mục còn chờ duyệt (49%) đủ điều kiện của nút xuất bản hàng loạt, 1.955 bị giữ (nghi ngờ nghĩa 864, bộ kiểm tra của job báo lỗi 711, không nhận ra 663, từ nhạy cảm hoặc thô tục 162, tên riêng 35; một mục có thể có nhiều lý do). Nghĩa tiếng Việt vẫn cần người duyệt kỹ, như đã ghi ở giai đoạn 1.
* **CEFR.** Haiku trùng Oxford ở 1.813/3.862 mục (47%), lệch 1 bậc 1.756, lệch từ 2 bậc 292; Haiku khó hơn Oxford 1.242 mục, dễ hơn 806. **Chưa áp `oxford:apply-cefr`**; mọi mục còn mang mức Haiku ước tính.
* **Mục từ đã xuất bản.** 23 mục `[auto]` hiện có `published = true`; cả 23 do admin bấm ở giao diện `/lookup/review` (có dòng `entry_edit_history` với `admin_id`, từ 22/10 04:31 đến 23/10 17:15 UTC), không phải công cụ nạp (nó chỉ tạo `published = false` và `enrich:publish` chưa được chạy).
* **Chi phí và dung lượng cả đợt.** Bộ đếm token tăng 40,22 triệu vào và 6,03 triệu ra, **$4,21** (hàng sổ $4,19) cho 3.872 mục từ, bằng **0,71 lần** tổng ước tính ($5,97), nên không chạm ngưỡng dừng 2 lần. Cơ sở dữ liệu từ 251,10 MB lên 289,38 MB; dữ liệu thật của 3.872 mục từ là 19,92 MB (5,3 KB mỗi mục); từ điển có 4.726 mục từ (3.881 `[auto]`).

**Giai đoạn 3 dừng ở đây. Chưa `oxford:apply-cefr`, chưa `enrich:publish`, chưa sửa `.env`, không commit.**

### Giai đoạn 4: kiểm tra lại tệp và nạp nốt (23/10/2026)

Phần sinh tự động ở trên vẫn là số liệu tích lũy (lần gửi #1 đến #14); các lần gửi lại bằng `enrich:enqueue` không nằm trong danh sách lần gửi nhưng trạng thái cuối của từ luôn lấy từ job gần nhất trong DB.

* **Tệp Oxford hiện hành không đổi.** Công cụ vẫn dùng `P:\Personal\WordyGo_Full\oxford_5000.json` (tệp duy nhất ở đó): 7.889.418 byte, sửa lần cuối 20/10/2026 05:25 UTC, **trước** lần gửi đầu tiên (05:58), 5.948 dòng, **4.958 từ khác nhau**, 4.949 từ hợp lệ sau bộ làm sạch. Con số "~6.000" là số **dòng**: 990 dòng là bản trùng của 883 từ (cùng từ ở nhiều mức CEFR hoặc loại từ). Bản gốc `P:\GRW\Finish_Done\oxford-5000-vocabulary-audio-definition\data\oxford_5000.json` (29/3/2026, 5.944 dòng, cấu trúc khác, không phải mảng) không được dùng. Phương án an toàn: dựa vào đúng tệp công cụ đang đọc và đối chiếu từng từ với `dictionary_entries`, `word_forms` và `word_enrichment_jobs`, không dùng chỉ số vị trí trong `.oxford-seed.local.json`.
* **Trạng thái của 4.949 từ hợp lệ** (đối chiếu trực tiếp với DB sau khi nạp xong):

| trạng thái | số từ |
|---|---|
| đã có mục từ (headword hoặc lemma) | 4.723 |
| là dạng biến trong `word_forms` | 193 |
| job đã ra mục từ dưới chính tả khác (`judgement` → `judgment`, `enquiry`, `enquire`, `counsellor`) | 4 |
| **đã phủ (có mục từ hoặc dạng biến)** | **4.920 (99,4%)** |
| `skipped / variant_form` | 7 (`enrol favour forth halt licence ought sceptical`) |
| `skipped / lemma_mismatch` | 1 (`counselling`) |
| `rejected / proper_noun` | 2 (`february`, `july`) |
| `failed / invalid_output` (đã chạy từ 4 lần trở lên) | 5 (`half handle level out you`) |
| `failed / upstream_error` | 14 (`film-maker high-profile large-scale line-up long-standing long-time make-up non-profit old-fashioned part-time post-war set-up so-called thought-provoking`) |

  Cộng với 9 cụm nhiều từ mà bộ làm sạch từ chối (`according to`, `all right`, `any more`, `have to`, `ice cream`, `next to`, `no one`, `per cent`, `used to`): đường ống chỉ nhận từ đơn. Không có "hơn 1.000 từ chưa nạp": khi giai đoạn 3 xong thì chỉ còn 16 từ cần xử lý.
* **Điều kiện trước khi gửi** (công cụ tự kiểm tra, không bỏ qua cái nào): `ENRICHMENT_ENABLED=true`, 30 chủ đề đủ, `ENRICHMENT_PUBLISH_POLICY=review`, chỉ một worker của máy này (`DESKTOP-C3OH1SK`). Biến đặt bằng shell, không sửa `.env`: `ENRICHMENT_MAX_JOBS_PER_DAY=3000` (lệnh gửi), `ENRICHMENT_WORKER_ENABLED=true`, `ENRICHMENT_WORKER_CONCURRENCY=2` (worker; 2 vì chỉ có 16 job). `pgboss.instance` chỉ có một `enrichment-worker` còn sống (của tôi); có thêm một `enrichment-sender` của máy chủ đã triển khai (`srv-…-hibernate-…`), là bên gửi chứ không phải worker, và không tính.
* **7 job không phải của công cụ nạp.** Lúc 17:50 đến 17:55 UTC, 6 từ có dấu gạch nối (`well-being`, `thought-provoking`, `set-up`, `post-war`, `non-profit`, `long-time`) cùng `hadn't` tự vào hàng đợi (`requested_by` rỗng, không có lần gửi mới trong tệp trạng thái, và lúc đó chưa có worker); nhiều khả năng đó là các lần tra từ trong ứng dụng đi qua máy chủ đã triển khai. Worker của tôi xử lý chúng như mọi job: `well-being` ra mục từ, `hadn't` `skipped / lemma_mismatch` (dạng rút gọn, không thuộc Oxford), 5 từ còn lại `upstream_error`.
* **Lần gửi lại các từ `upstream_error`.** Chạy thử rồi `--confirm` cho 10 từ (lần #13): chỉ `decision-making` đáng lẽ qua (Free Dictionary trả 200), nhưng 9 từ kia làm **cầu dao `free_dictionary` mở** nên nó cũng bị `circuit open` cả 4 lần chạy. Tôi tắt worker bằng SIGINT, bật lại (cầu dao nằm trong bộ nhớ của tiến trình), rồi gửi riêng `decision-making` (`--offset 4 --limit 1`, lần #14): ra mục từ. Còn lại 14 từ vẫn lỗi; lượt gửi lại thứ hai không có ích nên không chạy.
* **Nguyên nhân thật của 14 từ `upstream_error` (đính chính nhận định ở giai đoạn 3).** Đường ống chỉ hỏi Free Dictionary khi Wiktionary không có hàng nào cho từ. Với từ mà **chính Free Dictionary không có**, API công cộng này hiện trả **HTTP 530** (Cloudflare "error code: 1033") thay vì 404: kiểm tra bằng `curl` ngày 23/10, `zebra`, `serendipity`, `well-being`, `decision-making` trả 200; `make-up`, `part-time`, `old-fashioned`, và cả `notaword`, `zzyzxqv`, `glimmering` trả 530. Vì vậy không phải "mọi từ có dấu gạch nối" mà là "từ Wiktionary và Free Dictionary đều không có" (ở Oxford 5000 hầu hết là từ ghép có dấu gạch nối). Đường ống coi 5xx là lỗi nhà cung cấp và thử lại; job `failed / upstream_error` sau 4 lần chạy, không tốn token.
* **Lần gửi lại các từ `invalid_output` (tối đa 2 lượt, bằng `enrich:enqueue` vì công cụ nạp coi hai lần hỏng là kết thúc).** 22 từ: lượt 1 qua 14 (`drift flat gut help hit hollow into opposite overnight right slow underground warm welcome`), lượt 2 qua thêm 3 (`function hope plus`); **còn 5 từ hỏng**: `half handle level out you` (đều là từ rất nhiều nghĩa). Nguyên nhân của 13 lần hỏng trong hai lượt, bản nháp cuối vi phạm: `schema_too_big @ senses` 9 (hơn 6 sense), `classifier_duplicate @ senses[].meanings_vi[]` 4. Không có `too_long`, `parenthesis` hay `too_many_syllables`.
* **Chi phí và thời gian giai đoạn 4.** 33 job gọi Haiku, 0,60 triệu token vào và 0,11 triệu ra, **$0,093** theo hàng sổ; bộ đếm cả đợt nạp lên **$4,31** (0,72 lần ước tính, ngưỡng dừng là 2 lần). Cầu dao của Free Dictionary mở vài lần; không có 429, hết ngân sách hay `upstream_budget_exceeded`. Hai worker (concurrency 2) chạy tổng cộng khoảng 20 phút, cả hai tắt bằng SIGINT (`shutdown_start SIGINT`), không `taskkill`; không còn `node.exe`.
* **Kết quả.** **19 mục từ mới** (`decision-making drift flat function gut help hit hollow hope into opposite overnight plus right slow underground warm welcome well-being`), tất cả `published = false`. DB có **4.745** mục từ (không tính dữ liệu thử), trong đó **3.900 `[auto]`**: 23 đã được admin xuất bản bằng tay ở giao diện, **3.877 chờ duyệt**. Không còn job `queued`/`running`, hàng đợi pg-boss trống.
* **Việc chờ bạn quyết** (tôi không làm vì cần sửa mã nguồn hoặc là quyết định nội dung):
  1. **14 từ `upstream_error`.** (a) Cho `freeDictionaryClient` coi HTTP 530 là "không có dữ liệu" (như 404) để Haiku làm tiếp bằng dữ liệu tần suất; rủi ro là một sự cố thật của Free Dictionary (cũng 530) bị đọc nhầm thành "không có từ", nên cần bạn đồng ý và có test; (b) tạo tay trong `/dictionary`; (c) để nguyên.
  2. **5 từ `invalid_output`** (`half handle level out you`): nới trần 6 sense cho từ chức năng, hoặc tạo tay bằng trình sửa mục từ.
  3. **10 từ bị luật chặn.** `enrol favour sceptical` (và `counselling`) là chính tả Anh mà dạng Mỹ (`enroll`, `favor`, `skeptical`, `counseling`) **chưa có** trong từ điển (chỉ có `license`, `counselor`); `halt forth ought` là dương tính giả của luật S2; `february july` là tên riêng. Có thể tạo tay, hoặc nạp trước dạng Mỹ bằng `enrich:enqueue` rồi coi dạng Anh là biến thể.
  4. `oxford:apply-cefr` (Haiku chỉ trùng mức CEFR của Oxford ở 47%) và `enrich:publish` vẫn chưa chạy, như đã dặn.

**Giai đoạn 4 dừng ở đây. Không `oxford:apply-cefr`, không `enrich:publish`, không sửa `.env`, không sửa mã nguồn, không commit.**
