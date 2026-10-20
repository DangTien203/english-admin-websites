# WordyGo · Hướng dẫn trang quản trị tra từ và làm giàu (P8)

Cập nhật 16/10/2026; bổ sung P9 (xuất bản hàng loạt theo nhóm ghi chú, sửa nghĩa từng sense, quyền đổi `published` ở trình sửa mục từ) · Dành cho admin: xem và điều khiển hàng đợi làm giàu, duyệt các mục từ do hệ thống tự tạo, theo dõi sức khỏe luồng tra từ. Khảo sát giao diện và các quyết định: `docs/lookup-admin-notes.md` · Vận hành: `docs/lookup-runbook.md` · Thiết kế: `docs/lookup-spec.md`.

Trong thanh bên trái có mục **Tra từ & làm giàu** (biểu tượng kính lúp) với ba màn hình: **Hàng đợi làm giàu**, **Duyệt mục từ tự tạo**, **Sức khỏe tra từ**. Địa chỉ: `/lookup/jobs`, `/lookup/review`, `/lookup/health`.

## 1. Ai làm được gì

| | `super_admin` | `content_editor` | `moderator` |
|---|:---:|:---:|:---:|
| Mở ba màn hình, xem danh sách và chi tiết | ✅ | ✅ | ✅ |
| Thêm từ vào hàng đợi, Thử lại job | ✅ | ✅ | ❌ |
| Xuất bản, Ẩn, Xuất bản hàng loạt | ✅ | ✅ | ❌ |
| Sửa nghĩa tiếng Việt của từng sense và bản dịch ví dụ (mục 3.3) | ✅ | ✅ | ❌ |
| Đổi ô **Published** trong trình sửa mục từ `/dictionary/:id/edit` | ✅ | ✅ | ❌ (ô bị khóa; giá trị gửi lên bị bỏ qua và ghi log) |
| Nút **Sửa** (mở trình sửa mục từ `/dictionary/:id/edit`) | ✅ | ✅ | ❌ (nút ẩn) |

Với `moderator`, các nút ghi **không được vẽ** trên trang, và nếu gọi thẳng API thì nhận `403 FORBIDDEN` (thử ghi bị ghi vào log, mục 6). Vai trò lấy lúc đăng nhập: đổi vai trò xong phải đăng nhập lại.

## 2. Màn hình "Hàng đợi làm giàu" (`/lookup/jobs`)

Mỗi dòng là một job làm giàu (bảng `word_enrichment_jobs`): từ nào, đang chờ, đã tạo mục từ, bị bỏ qua hay lỗi.

### 2.1 Thêm từ vào hàng đợi (không có với moderator)

1. Dán danh sách vào ô **Thêm từ vào hàng đợi**, **mỗi từ một dòng**, tối đa **50 từ** mỗi lần. Dòng trống bị bỏ; từ gõ hai lần chỉ gửi một lần. Bộ đếm bên cạnh nút cho biết đang có bao nhiêu từ.
2. Bấm **Thêm vào hàng đợi**. Bảng kết quả hiện từng từ:

| Kết quả | Ý nghĩa |
|---|---|
| Đã thêm vào hàng đợi | job mới đã được tạo (tính vào trần `ENRICHMENT_MAX_JOBS_PER_DAY` của ngày UTC) |
| Đã có trong hàng đợi | từ đó đang chờ hoặc đang chạy; không tạo thêm |
| Bỏ qua: Đã có mục từ trong từ điển | đã có mục từ khớp headword, lemma hoặc dạng biến (xuất bản hay chưa) |
| Bỏ qua: Từ không hợp lệ | không qua bộ làm sạch từ (có chữ số, khoảng trắng, quá dài…) |
| Bỏ qua: Đã hết trần job trong ngày | chạm `ENRICHMENT_MAX_JOBS_PER_DAY`; thử lại sau 00:00 UTC (07:00 giờ Việt Nam) |
| Bỏ qua: Đã có job cho từ này | hàng đợi của pg-boss đã giữ một job cho từ mà sổ chưa thấy |
| Làm giàu đang tắt | `ENRICHMENT_ENABLED=false` ở máy chủ này; trang hiện thêm một dải cảnh báo vàng |
| Lỗi | hàng đợi hỏng. Từ đó và mọi từ sau nó **không** được thử (để một hàng đợi hỏng không tạo thêm hàng chục dòng lỗi); xem log và `docs/lookup-runbook.md` mục 10.4 |

3. Job do trang gửi không gắn với người dùng nào (`requested_by` trống) và không gắn ebook nào. Người gửi chỉ có trong log `admin_action`.
4. Xong rồi tải lại trang để thấy job mới ở đầu bảng. Một worker phải đang chạy ở đâu đó mới xử lý job (`npm run worker` hoặc dịch vụ worker); trang này chỉ gửi.

### 2.2 Đọc bảng job

Cột: **Từ**, **Trạng thái** (Đang chờ, Đang chạy, Thành công, Bị từ chối, Lỗi, Bỏ qua), **Lý do** (mã kèm lời giải thích; bảng mã đầy đủ ở `docs/lookup-enrichment.md` mục 11), **Lần chạy**, **Mục từ** (liên kết; "chờ duyệt" hoặc "đã xuất bản" nếu mục từ do job tạo, "mục từ có sẵn" nếu không), **Model và token**, **Tạo lúc**, **Xong lúc** (giờ Việt Nam, UTC+7).

Bộ lọc (bấm **Lọc**): từ khóa (một phần của từ), trạng thái, lý do (hoặc "không có lý do"), từ ngày, đến ngày (**ngày UTC**, gồm cả hai đầu). Phân trang 20 dòng.

### 2.3 Thử lại một job (không có với moderator)

Nút **Thử lại** chỉ hiện ở dòng thỏa **cả hai**:

* trạng thái **Lỗi** hoặc **Bỏ qua**, với lý do `upstream_error`, `budget`, `daily_cap`, `stale`, `queue_error` hoặc `dead_letter` (nguyên nhân nằm ngoài chính từ đó, thử lại có thể thành công); và
* từ đó **không** đang chờ hoặc đang chạy (khi đó dòng ghi "đang chờ").

Bấm nút → một job **mới** được gửi qua đúng bộ gửi job của đường tra từ (giữ các chốt: đã có mục từ, một job đang hoạt động mỗi từ, trần ngày). Dòng cũ **giữ nguyên làm lịch sử**; dòng mới xuất hiện ở đầu bảng. Nếu từ đã có mục từ trong lúc đó hoặc đã chạm trần ngày thì trang báo "Không gửi lại được …: <lý do>" và không tạo gì. Các lỗi **không thử lại được** (`invalid_output`, `config_error`, `exists`, `variant_form`, `proper_noun`, …) cần sửa nguyên nhân hoặc xử lý tay (`docs/lookup-runbook.md` mục 10).

## 3. Màn hình "Duyệt mục từ tự tạo" (`/lookup/review`)

Liệt kê các mục từ do job tạo (cột `admin_note` bắt đầu bằng `[auto]`). Mục từ làm tay không hiện ở đây.

### 3.1 Danh sách (bên trái)

* Bộ lọc **Trạng thái**: **Chờ duyệt** (mặc định, `published = false`), **Đã xuất bản**, **Tất cả**; ô **Tìm theo từ** (headword hoặc lemma). 20 dòng mỗi trang.
* Mỗi dòng: từ, loại từ, CEFR (ước tính), số nghĩa, các huy hiệu **thiếu tầng A** (đỏ) và **N ghi chú** (vàng), và nghĩa tiếng Việt của mục từ.
* Bấm một dòng để xem chi tiết ở khung bên phải (địa chỉ trình duyệt đổi thành `?entry=<id>`, sao chép được để gửi người khác).

### 3.2 Chi tiết (bên phải) và cách duyệt nhanh

Từ trên xuống:

1. **Đầu trang:** từ, dạng gốc, loại từ, CEFR (ước tính), IPA, trạng thái; các nút **Xuất bản** (hoặc **Ẩn** nếu đã xuất bản), **Sửa**, **Xem trong từ điển**.
2. **Khung đỏ "Thiếu trường bắt buộc (tầng A)":** hiện khi thiếu một trong: headword, lemma, loại từ, nghĩa tiếng Việt của mục từ, một sense có cả định nghĩa tiếng Anh và tiếng Việt, một ví dụ có cả tiếng Anh và tiếng Việt.
3. **Ghi chú của Haiku (`notes_for_review`), tách làm hai:** khung vàng **"Cần xem trước khi xuất bản"** (nghi ngờ nghĩa, từ nhạy cảm, tên riêng, bộ kiểm tra báo lỗi, ghi chú không nhận ra): **đọc trước khi xuất bản**, và chúng chặn xuất bản hàng loạt; khung xám **"Lưu ý nhẹ của Haiku"** (CEFR ước tính, nghĩa đã bỏ có chủ ý, nghĩa đã gộp, cách dùng, dữ liệu nguồn…): không chặn nhưng vẫn hiện ở đây, mỗi dòng kèm tên nhóm. Dòng trên cùng cho biết mục từ có **đủ điều kiện xuất bản hàng loạt** hay không (mục 3.4).
4. **Nghĩa tiếng Việt của mục từ:** danh sách các nghĩa (đây là trường dự phòng app dùng khi sense không có nghĩa).
5. **Các nghĩa (sense):** (nút **Sửa nghĩa tiếng Việt** ở mỗi sense, mục 3.3) mỗi sense có loại từ, định nghĩa tiếng Anh, **các nghĩa tiếng Việt tách thành danh sách** (tách `definition_vi` theo `; `), ví dụ, đồng nghĩa và trái nghĩa. Nghĩa bị **tô vàng** khi:
   * **"dài bất thường"**: quá 40 ký tự hoặc quá 6 chữ (giới hạn mà bộ kiểm tra của job áp lên mô hình, nên nghĩa dài hơn thường do sửa tay hoặc mục từ cũ);
   * **"có trong ghi chú cần xem"**: nội dung nghĩa xuất hiện trong một ghi chú của Haiku.
6. **Thông tin khác:** chủ đề, hạng tần suất, đếm được / ngoại động, từ nguyên, đồng nghĩa và trái nghĩa nối tới mục từ khác, dạng biến; thành ngữ, cụm động từ, cụm từ hay đi cùng (bấm để mở).
7. **Ghi chú của hệ thống:** `admin_note` đã tách thành nguồn, model, id job (liên kết sang bảng job của từ), trường **tầng B còn thiếu**, giá trị ước tính; kèm văn bản gốc.
8. **Lịch sử thay đổi:** 10 dòng `entry_edit_history` mới nhất (ai, lúc nào, đổi gì).

### 3.3 Xuất bản, Ẩn, Sửa (không có với moderator)

* **Xuất bản / Ẩn:** đổi `published` và ghi một dòng `entry_edit_history` (`field_name = 'published'`, `old_value` và `new_value` là `true`/`false`, `admin_id` là người bấm) **trong cùng một transaction**. Không có thao tác xóa mục từ; muốn bỏ một mục từ thì Ẩn.
  * Xuất bản mục từ còn **thiếu tầng A**: trang hỏi lại ("Vẫn xuất bản?"). API vẫn cho phép (quyết định của admin) và trả danh sách trường thiếu.
  * Xuất bản mục từ có **ghi chú của Haiku** là việc của người duyệt, không bị chặn.
  * Xuất bản hoặc ẩn một mục từ đã ở trạng thái đó là không làm gì và không ghi lịch sử.
* **Sửa:** mở **trình sửa mục từ có sẵn** (`/dictionary/<id>/edit`). Cần biết:
  * Nó chỉ sửa trường cấp mục từ (`meaning_vi`, IPA, CEFR, chủ đề, ghi chú admin…). Nghĩa của **từng sense** (`entry_senses.definition_vi`), cái mà app hiển thị trước tiên, sửa ở ngay màn chi tiết (đoạn **"Sửa nghĩa tiếng Việt của một sense"** bên dưới).
  * Chỉ **`super_admin` và `content_editor`** đổi được ô **Published** (P9). Với `moderator` ô bị khóa kèm lời giải thích; nếu họ vẫn gửi một giá trị `published` khác với trạng thái hiện tại (gọi thẳng), giá trị đó **bị bỏ qua** (mục từ giữ nguyên, không ghi lịch sử) và một dòng log `admin_action` / `dictionary.edit.published` / `forbidden` được ghi; các trường khác vẫn lưu bình thường. Nhờ vậy trình sửa không còn là đường vòng qua `403` của API xuất bản.
  * Ô **Published** của nó nay đúng như tên: tick = công khai, bỏ tick = ẩn, và đổi trạng thái ở đó cũng ghi lịch sử. (Trước P8, bỏ tick vẫn xuất bản; xem `docs/lookup-admin-notes.md` mục 10.1.)
  * Headword và lemma bị hạ chữ thường khi lưu.

#### Sửa nghĩa tiếng Việt của một sense (không có với moderator)

Ở mỗi sense của màn chi tiết có nút **Sửa nghĩa tiếng Việt**. Bấm nút thì biểu mẫu hiện **ngay tại chỗ**:

* ô **Nghĩa tiếng Việt**, các nghĩa ngăn cách bằng dấu chấm phẩy (`;`), đúng như `definition_vi` được lưu (các nghĩa nối bằng `; `, spec §9.8);
* với mỗi ví dụ **đã có bản dịch**, một ô sửa bản dịch tiếng Việt của ví dụ (câu tiếng Anh không sửa được).

Bấm **Lưu**: trang gọi `PATCH /lookup/api/auto-entries/:id/senses/:senseId` (mục 5), vẽ lại chi tiết từ dữ liệu đã lưu (kèm cờ "dài bất thường" / "có trong ghi chú cần xem") và thêm dòng mới vào **Lịch sử thay đổi**. **Hủy** đóng biểu mẫu, không ghi gì. Kiểm tra đầu vào:

| Quy tắc | Giá trị |
|---|---|
| Làm sạch trước khi kiểm | chuẩn hóa Unicode NFC; bỏ ký tự điều khiển và ký tự vô hình (zero-width, đảo chiều văn bản…); mọi chuỗi khoảng trắng, xuống dòng, tab thành **một** dấu cách; cắt hai đầu |
| Nghĩa tiếng Việt | không rỗng (sau khi bỏ nghĩa rỗng và nghĩa lặp, không phân biệt hoa thường); mỗi nghĩa tối đa **100** ký tự; tối đa **8** nghĩa; cả chuỗi tối đa **300** ký tự |
| Bản dịch ví dụ | không rỗng; tối đa **500** ký tự |
| Cấm | ký tự `<` và `>` (không nghĩa nào cần đến chúng; đó cũng là cách một thẻ HTML bắt đầu) |
| Chỉ sửa được | `definition_vi` của sense và `example_vi` của ví dụ **thuộc sense đó**; trường khác trong thân yêu cầu bị từ chối |
| Mục từ | chỉ mục từ `[auto]`, đã xuất bản hay chưa đều sửa được; sense và ví dụ phải thuộc đúng mục từ trong đường dẫn (sai thì `404`) |

Mỗi văn bản **thật sự đổi** để lại một dòng `entry_edit_history` trong cùng transaction với việc ghi (một lỗi ghi lịch sử thì văn bản cũng không đổi): `field_name` = `sense:<id sense>:definition_vi` hoặc `sense:<id sense>:example_vi:<id ví dụ>` (trang hiển thị bằng chữ: "nghĩa tiếng Việt của sense …1a2b3c4d"), `old_value` và `new_value` là văn bản trước và sau, `admin_id` là người bấm Lưu. Gửi lại đúng nội dung đang lưu thì không ghi gì (`changed: false`). Mục từ được đánh dấu `updated_at`.

Điều cần biết: `entry_answer_aliases` (các đáp án chấp nhận được khi luyện tập, sinh từ các nghĩa lúc job chạy, spec §10.7) **không** được sinh lại khi bạn sửa nghĩa; nghĩa mới chỉ có tác dụng ở chỗ app hiển thị nghĩa. Trường `meaning_vi` ở cấp mục từ cũng không đổi theo.

### 3.4 Xuất bản hàng loạt (không có với moderator)

1. Chỉ các mục từ **thỏa cả ba** mới có ô chọn: (a) thuộc nhóm `[auto]`, (b) **tầng A đủ**, (c) **không có ghi chú "cần xem"** của Haiku (bảng ngay dưới mục này; lưu ý nhẹ không chặn), và chưa xuất bản. Mục khác hiện dấu "—" (di chuột để xem lý do).
2. Tick từng ô, hoặc tick **Chọn các mục đủ điều kiện** để chọn hết trang. Nút **Xuất bản hàng loạt (N)** sáng lên; tối đa **100 mục** mỗi lần.
3. Bấm nút: một **hộp xác nhận** hiện **số mục** sắp xuất bản và **5 mục lấy ngẫu nhiên** trong số đã chọn (chọn ít hơn 5 thì hiện hết; mỗi lần mở là một mẫu khác). **Xuất bản** để xác nhận; **Hủy** hoặc phím Esc để thôi, không gửi gì. (Trình duyệt không có thẻ `<dialog>` nhận một hộp `confirm()` thường cùng nội dung.) Thông báo sau khi tải lại cho biết số mục đã xuất bản và các mục bị bỏ qua kèm lý do. Máy chủ **kiểm lại cả ba điều kiện** lúc xuất bản (dữ liệu có thể đã đổi từ lúc bạn mở trang); mục không đạt bị bỏ qua, các mục còn lại vẫn xuất bản. Tất cả trong một transaction: lỗi bất ngờ thì không mục nào được xuất bản.
4. Lý do bỏ qua: không tìm thấy; không phải mục từ tự tạo; đã xuất bản; thiếu trường bắt buộc (tầng A); có ghi chú cần xem của Haiku (`has_review_notes`; API kèm `blocking_notes`, các ghi chú đã chặn).

#### Ghi chú nào chặn xuất bản hàng loạt (P9)

Trước P9, **một** ghi chú bất kỳ của Haiku đã đủ để chặn một mục từ; vì mô hình ghi 2 đến 6 ghi chú cho mọi mục, xuất bản hàng loạt không chọn được mục nào (29 trên 29 mục từ ngày 16/10/2026). Nay mỗi ghi chú được xếp vào một **nhóm** theo nội dung (so khớp từ khóa trên chữ không dấu), và chỉ các nhóm **"cần xem"** mới chặn; ghi chú **nhẹ** không chặn nhưng vẫn hiện ở màn chi tiết. Một ghi chú không khớp nhóm nào thì **chặn**: không bao giờ cho qua mặc định.

| Nhóm | Chặn xuất bản hàng loạt | Số ghi chú (41 mục từ, 16/10/2026) | Ví dụ thật |
|---|:---:|---:|---|
| Nghi ngờ nghĩa (`meaning_doubt`) | **có** (cần xem) | 14 | "Nghĩa 'phố' và 'dãy nhà' có thể gộp, cần kiểm tra lại." · "…đã bổ sung từ kiến thức chung, cần kiểm tra lại." · "…rất phổ biến nhưng không có trong dữ liệu nguồn; cần bổ sung." |
| Bộ kiểm tra của job báo lỗi (`validator_flag`) | **có** | 11 | "[kiểm tra] senses[2].definition_en dùng lại chính từ đang định nghĩa" |
| Từ nhạy cảm hoặc thô tục (`sensitive`) | **có** | 1 | "Nghĩa 'bisexual' … bị bỏ qua vì hiếm và không phù hợp người học." (luôn chặn, kể cả khi nói là đã bỏ) |
| Tên riêng (`proper_noun`) | **có** | 0 | "Từ này có thể là tên riêng" (chỉ khi KHÔNG nói là đã bỏ nghĩa đó) |
| Còn lại, không nhận ra (`other`) | **có** | 0 | mọi ghi chú không khớp nhóm nào: một người đọc nó, không cho qua mặc định |
| Lưu ý nhẹ về cách dùng (`usage_check`) | không | 10 | "…đánh dấu is_transitive là true…, cần kiểm tra lại." · "…cần xác nhận cách dùng ở Mỹ" · "…xếp vào mức formal, cần xác nhận lại." |
| CEFR ước tính (`cefr_estimate`) | không | 26 | "Mức CEFR C1 ước tính từ tần suất thấp (zipf 3,56); cần xem lại." (mọi mức CEFR đều là ước tính và hiện là "ước tính") |
| Nghĩa đã bỏ có chủ ý (`omitted_sense`) | không | 58 | "Nghĩa 'đất sét bùn' rất hiếm và chuyên ngành nên không đưa vào." · "Họ riêng Crane và tên sông không đưa vào…" |
| Nghĩa gần nhau đã gộp (`merged_sense`) | không | 10 | "Nghĩa 'then cửa' và 'chốt cửa' gần nhau, đã gộp hợp lý." |
| Gợi ý biên tập (`suggestion`) | không | 1 | "…cần bổ sung trái nghĩa như 'confused' nếu muốn." |
| Ghi chú về dữ liệu nguồn (`source_data`) | không | 10 | "Datamuse không cung cấp antonym; antonyms lấy từ Wiktionary." |
| Giải thích điều đã giữ hay đã ghi (`kept_decision`) | không | 3 | "Nghĩa mol … đã giữ vì thường gặp trong học tập." |
| Thẻ đã bị bộ kiểm tra bỏ (`validator_tag_dropped`) | không | 6 | "[kiểm tra] bỏ academic_formal: chỉ dành cho từ trừu tượng trình độ C1 hoặc C2…" |
| **Tổng** | | **150** | |

**Kết quả trên DB dev (16/10/2026): 23 trong 41 mục từ `[auto]` đủ điều kiện** (18 trong 29 mục từ cũ, 5 trong 12 mục từ của các lần nghiệm thu ngày 16/10); 18 mục bị giữ lại: 12 vì ghi chú nghi ngờ nghĩa, 8 vì bộ kiểm tra báo lỗi, 1 vì nhắc tới nghĩa nhạy cảm (một mục có thể thuộc nhiều nhóm). Cả 41 mục đều đủ tầng A.

**Điều chỉnh luật.** Bảng nhóm là hằng số `REVIEW_NOTE_CATEGORIES` trong `services/lookup/reviewNotes.ts`: đổi `blocks` của một dòng, hoặc thêm từ khóa vào mẫu của nhóm, là sửa được luật (có test ở `tests/admin/reviewNotes.test.ts`). `npx tsx scripts/dev/classify-review-notes.ts` (chỉ đọc DB) in lại bảng này trên dữ liệu hiện có; `--entries` chỉ in danh sách mục từ, `--md` in bảng Markdown. Hai quyết định đáng xem lại: (1) nhóm `validator_flag` ("định nghĩa tiếng Anh dùng lại chính từ đang định nghĩa") đang **chặn**; coi nó là nhẹ thì thêm 5 mục (bolt, crane, karaoke, rack, sushi), được 28; (2) nhóm `meaning_doubt` coi là nhẹ thì được 33, nhưng đó chính là điều người duyệt cần đọc nhất.

## 4. Màn hình "Sức khỏe tra từ" (`/lookup/health`)

Nút **Làm mới** tải lại trang. Dòng đầu cho biết **cấu hình của tiến trình đang phục vụ trang** (tra qua dịch vụ ngoài, gửi job, worker, chính sách xuất bản). Worker chạy ở dịch vụ khác có thể cấu hình khác (`docs/lookup-runbook.md` mục 1).

### 4.1 Thẻ nhà cung cấp

Một thẻ cho mỗi nguồn: **Google Dịch**, **Free Dictionary**, **Datamuse**, **Anthropic (làm giàu)**, **Anthropic (tra nhanh)**. Mỗi thẻ có trạng thái **breaker** (cầu dao): Đóng (bình thường), Nửa mở (đang thử lại), Mở (đang bỏ qua nguồn này), và số lỗi liên tiếp.

* **Google Dịch:** thanh ký tự đã dùng trong tháng (UTC) so với `GOOGLE_TRANSLATE_MONTHLY_CHAR_LIMIT`.
* **Anthropic:** token vào và ra trong tháng. Trần chi tiêu do Anthropic đặt nên **không có thanh**.
* Màu thẻ: xanh = ổn; **vàng** = breaker nửa mở, hoặc mức dùng từ **80%** trở lên; **đỏ** = breaker mở, hoặc mức dùng đạt **100%**.

### 4.2 Job và hàng đợi

* **Job hôm nay (UTC):** đã gửi / `ENRICHMENT_MAX_JOBS_PER_DAY` (vàng từ 80%, đỏ ở 100%), số job còn lại và số job theo trạng thái.
* **Hàng đợi (pg-boss):** số job đang chờ, đang chạy, trong hàng lỗi chết. Vàng khi hàng lỗi chết có job. Dòng gợi ý hiện khi có job chờ mà không job nào chạy (worker có thể đã dừng).
* **Lượt tra:** số lượt tra, tỉ lệ bản tạm thiếu dữ liệu, độ trễ p50 và p95 **từ lúc tiến trình này khởi động** (mất khi khởi động lại; nhiều bản sao ứng dụng thì mỗi bản một số).

### 4.3 20 lỗi gần nhất

Job `failed` và job `skipped / budget` mới nhất: từ (liên kết sang bảng job), trạng thái, lý do, số lần chạy, lúc nào.

### 4.4 Từ được tra nhiều mà từ điển chưa có

Top 50 từ trong **7 ngày** (mặc định) hoặc **30 ngày** (nút chuyển ở góc), tính từ `word_lookups` với kết quả "bản tạm" hoặc "không tìm thấy". Dòng cũ không có `word_text` bị bỏ qua. Từ đã có mục từ **xuất bản** thì không hiện; từ có mục từ **chưa xuất bản** vẫn hiện, kèm liên kết "chờ duyệt".

Mỗi dòng: số lượt tra, lần tra cuối, **job gần nhất** (nếu có), mục từ (nếu có), và nút **Thêm vào hàng đợi** (chỉ hiện khi chưa có mục từ, chưa có job đang chờ hoặc chạy, và bạn có quyền ghi). Kết quả của nút giống mục 2.1.

## 5. API (JSON)

Các nút gọi API dưới `/lookup/api`; công cụ khác cũng dùng được **khi có phiên đăng nhập quản trị** (cookie phiên, không dùng JWT của app di động). Vỏ trả về giống API di động (`{ success, data }` / `{ success: false, error: { code, message, details? } }`); trường JSON dùng snake_case, **riêng `/health` giữ khóa camelCase** của `getSnapshot()` (cùng nội dung `npm run health:snapshot`). Thân ghi phải là `application/json`. Phân trang: `page` (từ 1), `limit` (mặc định 20, tối đa 100); kết quả `{ items, pagination: { page, limit, total, total_pages } }`.

| Phương thức và đường dẫn | Quyền | Việc làm | Tham số, kết quả |
|---|---|---|---|
| `GET /lookup/api/jobs` | đọc | danh sách job | `status` (`queued`, `running`, `succeeded`, `rejected`, `failed`, `skipped`), `reason` (mã, hoặc `none`), `q`, `from`, `to` (`YYYY-MM-DD`, UTC, gồm hai đầu). Mỗi dòng: `id, word, status, reason, attempts, model, input_tokens, output_tokens, created_at, finished_at`, `entry` (`{ id, headword, published, is_auto, url }` hoặc `null`), `retryable`, `retry_blocked` (`status_not_retryable` hoặc `word_active`) |
| `POST /lookup/api/jobs` | ghi | thêm từ vào hàng đợi | `{ "words": ["a", "b"] }` hoặc một chuỗi mỗi từ một dòng; **tối đa 50** (51 → `400 VALIDATION_ERROR`, không gửi gì). Trả `{ results: [{ word, status, reason? }], summary }`; `status`: `queued`, `already_queued`, `skipped` (+ `reason`: `exists`, `invalid_word`, `daily_cap`, `duplicate`), `disabled`, `error` (+ `reason`: `queue_error`, `not_attempted`) |
| `POST /lookup/api/jobs/:id/retry` | ghi | thử lại một job | `200 { previous_job_id, word, result: { status, reason? } }`. `404 NOT_FOUND`; `409 JOB_NOT_RETRYABLE` (trạng thái hoặc lý do không thuộc danh sách); `409 WORD_ALREADY_ACTIVE` (từ đang `queued` / `running`); `409 ENRICHMENT_DISABLED`; `503 QUEUE_UNAVAILABLE` |
| `GET /lookup/api/auto-entries` | đọc | danh sách mục từ tự tạo | `status` = `pending` (mặc định), `published`, `all`; `q`. Mỗi dòng: `id, headword, lemma, pos, meaning_vi, cefr_level, published, created_at, sense_count, tier_a_complete, tier_a_missing, review_note_count` (mọi ghi chú của Haiku), `blocking_note_count` (các ghi chú **cần xem**, chặn xuất bản hàng loạt), `eligible_for_bulk_publish` (chưa xuất bản, đủ tầng A, `blocking_note_count = 0`) |
| `GET /lookup/api/auto-entries/:id` | đọc | chi tiết một mục từ tự tạo | các trường chính; `meanings_vi` và `senses[].meanings_vi` là `[{ text, too_long, in_review_notes }]`; `senses[]` có `id`, ví dụ (`examples[]` = `{ id, example_en, example_vi }`), đồng nghĩa, trái nghĩa; `topics`, `synonyms`, `antonyms`, `word_forms`, `idioms`, `phrasal_verbs`, `collocations`, `history`, `job`; `note` = `admin_note` đã tách (`sources, model, job_id, publish_note, tier_a_missing, tier_b_missing, estimated, review_notes, review_notes_classified, other`; `review_notes_classified` = `[{ text, category, label, blocks }]`) cùng `admin_note` gốc; `tier_a_complete`, `tier_a_missing`, `blocking_note_count`, `eligible_for_bulk_publish`, `has_flagged_meanings`. `404` nếu không phải mục từ `[auto]` |
| `POST /lookup/api/auto-entries/:id/publish` | ghi | xuất bản | `200 { id, headword, published: true, changed, tier_a_missing }`; `changed: false` nếu đã xuất bản (không ghi lịch sử). `404` nếu không phải mục từ `[auto]` |
| `POST /lookup/api/auto-entries/:id/hide` | ghi | ẩn | như trên với `published: false` |
| `POST /lookup/api/auto-entries/bulk-publish` | ghi | xuất bản hàng loạt | `{ "entry_ids": [uuid, …] }`, **tối đa 100** (101 → `400`); id trùng gộp lại. Trả `{ requested, published: [{ id, headword }], skipped: [{ id, headword, reason, tier_a_missing?, blocking_notes? }] }`; `reason`: `not_found`, `not_auto`, `already_published`, `tier_a_incomplete`, `has_review_notes` (kèm `blocking_notes: [{ text, category, label }]`, chỉ các ghi chú đã chặn) |
| `PATCH /lookup/api/auto-entries/:id/senses/:senseId` | ghi | sửa nghĩa tiếng Việt của một sense | `{ "definition_vi"?: "a; b", "examples"?: [{ "id": uuid, "example_vi": "…" }] }` (ít nhất một trong hai; quy tắc ở mục 3.3). `200 { entry_id, sense_id, changed, changes: [{ field, example_id? }], definition_vi, meanings_vi: [{ text, too_long, in_review_notes }], examples: [{ id, example_en, example_vi }] }`; `400 VALIDATION_ERROR` (trường lạ, rỗng, quá dài, có `<` hoặc `>`, id sai dạng, ví dụ lặp); `404 NOT_FOUND` (mục từ không phải `[auto]`, sense hoặc ví dụ không thuộc mục từ/sense trong đường dẫn); `403 FORBIDDEN` cho moderator và cho yêu cầu từ trang khác |
| `GET /lookup/api/health` | đọc | ảnh chụp sức khỏe | `LookupHealthService.getSnapshot()` nguyên dạng: `generatedAt, breakers, google, anthropic, jobs, queue, recentFailures, lookups, counters` (`docs/lookup-runbook.md` mục 2.1) |
| `GET /lookup/api/missing-words` | đọc | từ được tra nhiều mà chưa có | `days` = 7 (mặc định) hoặc 30; tối đa 50 dòng `{ word, lookups, last_lookup_at, job: { status, reason } hoặc null, entry: { id, headword: null, published, is_auto, url } hoặc null, can_enqueue }` |

Chưa đăng nhập: `401 UNAUTHORIZED`. Sai vai trò khi ghi: `403 FORBIDDEN`. Đường dẫn không có: `404 NOT_FOUND` (JSON). Các trang HTML: `GET /lookup` (chuyển tới `/lookup/jobs`), `/lookup/jobs`, `/lookup/review` (tham số `status`, `q`, `entry`), `/lookup/review/:id/detail` (chỉ phần chi tiết, dạng HTML), `/lookup/health` (tham số `days`).

## 6. Nhật ký

Mỗi thao tác **ghi** để lại một dòng log JSON `evt = "admin_action"`:

```json
{"evt":"admin_action","admin_id":"…","action":"entry.publish","target_type":"entry","target_id":"…","result":"ok","changed":true,"tier_a_missing":0}
```

| `action` | Khi nào | Trường thêm |
|---|---|---|
| `jobs.add_words` | thêm từ | `requested, processed, queued, already_queued, skipped, disabled, error` (số lượng; **không** có danh sách từ) |
| `jobs.retry` | thử lại job | `word_sent, result_status` |
| `entry.publish`, `entry.hide` | xuất bản, ẩn một mục từ | `changed`, `tier_a_missing` (số trường thiếu) |
| `entry.edit_sense` | sửa nghĩa tiếng Việt của một sense | `changed`, `fields` (số văn bản đã đổi). **Không** có nội dung văn bản |
| `dictionary.edit.published` | một vai trò không được đổi `published` gửi giá trị khác trạng thái hiện tại qua `POST /dictionary/:id/edit` (giá trị bị bỏ qua) | `result: "forbidden"`, `requested`, `kept` |
| `entry.bulk_publish` | xuất bản hàng loạt | `requested, published, skipped` |
| `POST /lookup/api/…` | thử ghi bị từ chối vì sai vai trò | `result: "forbidden"` |

`result`: `ok`; `rejected:<MÃ_LỖI>` (từ chối có chủ đích, ví dụ `rejected:JOB_NOT_RETRYABLE`); `forbidden`; `error` (lỗi bất ngờ). Log **không** chứa e-mail hay tên admin, thân yêu cầu, `admin_note` hay nội dung nghĩa; chỉ có id, mã và số đếm; khóa API (nếu lọt vào) bị che. Việc xuất bản và ẩn còn để lại dòng trong `entry_edit_history`, nơi **xem được ai làm** ngay trong chi tiết mục từ. Việc đọc (xem danh sách, chi tiết, sức khỏe) không ghi log.

## 7. Giới hạn và điều cần biết

* Chỉ **xem và điều khiển**: trang không xóa mục từ, không sửa các trường khác của sense (loại từ, định nghĩa tiếng Anh…), không chạy job (worker chạy riêng). Sửa được nghĩa tiếng Việt và bản dịch ví dụ của sense (mục 3.3), đó là hết.
* Ngày và tháng của bộ đếm (`Job hôm nay`, ký tự Google, token) theo **UTC**; bảng hiển thị giờ Việt Nam.
* Số liệu "Lượt tra" trên màn sức khỏe nằm trong bộ nhớ của **một** tiến trình.
* Chi tiết một mục từ gom khoảng 15 truy vấn (chạy song song); trên DB ở xa (Neon, ~70 ms mỗi lượt) mất khoảng 1 đến 2 giây để hiện khung chi tiết.
* Danh sách "từ được tra nhiều" quét `word_lookups` theo `created_at` (đã có chỉ mục); xem 400 từ nhiều nhất rồi lọc từ đã xuất bản. Khi bảng này lớn, kiểm tra lại thời gian trả lời.

## 8. Sự cố thường gặp

| Dấu hiệu | Nguyên nhân thường gặp |
|---|---|
| "Làm giàu đang tắt" khi thêm từ | `ENRICHMENT_ENABLED=false` ở **dịch vụ phục vụ trang quản trị**; đổi biến rồi khởi động lại dịch vụ đó (`docs/lookup-runbook.md` mục 1) |
| Đã thêm từ nhưng job không chạy | không có worker: kiểm tra màn sức khỏe (thẻ hàng đợi) và `docs/lookup-runbook.md` mục 10.4 |
| 403 khi bấm nút | tài khoản là `moderator`, hoặc vai trò vừa đổi mà chưa đăng nhập lại |
| Nút Thử lại không hiện | job không thuộc các lý do thử lại được (mục 2.3), hoặc từ đó đang chờ hoặc chạy |
| Xuất bản hàng loạt không chọn được mục nào | mọi mục đều có ghi chú **cần xem** của Haiku (nghi ngờ nghĩa, bộ kiểm tra báo lỗi, nhạy cảm, không nhận ra) hoặc thiếu tầng A (mục 3.4); ghi chú nhẹ không chặn. Mở chi tiết để đọc, hoặc chỉnh bảng nhóm ở `services/lookup/reviewNotes.ts` |
