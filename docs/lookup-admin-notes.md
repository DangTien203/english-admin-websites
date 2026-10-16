# WordyGo · Ghi chú khảo sát trang quản trị (P8)

Ngày khảo sát: 15 đến 16/10/2026 · Đọc code của trang quản trị hiện có trước khi viết trang cho luồng tra từ và làm giàu (`docs/lookup-spec.md` §0.1). Phần 1 đến 8 là **điều đã có** (chỉ đọc); phần 9 là cách P8 bám theo; phần 10 là **những điều thấy trong lúc khảo sát** (có điều đã sửa, có điều chưa).

## 1. Khung giao diện

| Hạng mục | Thực tế |
|---|---|
| Framework | Express 4 + **EJS** + `express-ejs-layouts`, dựng trang **ở máy chủ**. Không có SPA, không bundler, không thư viện giao diện (React, Vue, Bootstrap, jQuery đều không có) |
| Bố cục | `views/layouts/main.ejs` (sidebar + header + vùng nội dung + hai dòng `<script>`); `views/partials/{sidebar,header,pagination}.ejs`. Mỗi trang là một tệp trong thư mục cùng tên với route (`views/dictionary/index.ejs`, …) |
| CSS | Một tệp `public/css/style.css` (biến `--primary`, `--danger`, …; lớp `.card`, `.card-header`, `.table-wrapper`, `.btn`, `.btn-sm`, `.badge-*`, `.stats-grid`, `.page-header`, `.form-group`; chế độ tối bằng `body.dark-mode`). Phần lớn bố cục của từng trang viết bằng `style="…"` ngay trong EJS |
| JavaScript phía trình duyệt | `public/js/main.js` (thu gọn sidebar, chế độ tối, tự đóng hộp thông báo sau 5 giây). Trang nào cần thêm thì để `<script>` ngay cuối tệp EJS (ví dụ `views/decks/show.ejs`); JS thuần kiểu ES5 (`var`, `function`, `fetch`) |
| Ngôn ngữ | Lẫn lộn: nhãn của các trang cũ chủ yếu tiếng Anh (`Dictionary`, `Users`, `Add Word`), thông báo lỗi và vài trang (AI Content, đăng nhập) bằng tiếng Việt. Trang mới của P8 viết tiếng Việt |
| Thông báo | `connect-flash` (`success`, `error`, `warning`), `injectAdmin` đưa vào `res.locals`, layout vẽ thành `.alert-*`. **`.alert-warning` chưa có kiểu CSS** (P8 thêm) |

## 2. Định tuyến và xác thực

| Hạng mục | Thực tế |
|---|---|
| Mount | `app.ts`: mỗi miền một mount phẳng (`/dashboard`, `/users`, `/dictionary`, `/decks`, `/ebooks`, `/games`, `/subscriptions`, `/ai-content`, …), mỗi mount một tệp `routes/<tên>.ts` và một `controllers/<tên>Controller.ts`. Đường dẫn nhiều từ dùng `kebab-case` (`/ai-content`, `/payment-methods`) |
| Phiên | `express-session`, **bộ nhớ trong tiến trình** (không khai báo store): mất khi khởi động lại; cookie 24 giờ, `secure: false`, **không đặt `sameSite`** |
| Đăng nhập | `POST /auth/login` (form), kiểm `admin_accounts` bằng bcrypt, ghi `req.session.admin = { id, email, full_name, role, avatar_url }` vào phiên. Vai trò **chụp lúc đăng nhập**: đổi vai trò hay khóa tài khoản chỉ có hiệu lực ở lần đăng nhập sau (hoặc khi phiên hết hạn) |
| Chặn | `requireAuth` (chưa đăng nhập → flash + chuyển tới `/auth/login`), `requireRole(...)` (sai vai trò → flash + chuyển tới `/dashboard`). **Cả hai chuyển hướng**, không trả JSON |
| Phân quyền hiện có | Nội dung (`/dictionary`, `/decks`, `/games`, `/ai-content`, `/users`): `super_admin` và `moderator`. `/approvals`, `/subscriptions`, `/settings`: chỉ `super_admin`. `content_editor` được định nghĩa nhưng **không có quyền vào trang nội dung nào** (`CLAUDE.md` nói rõ điều này) |
| Dữ liệu cho mọi trang | `injectAdmin` chạy ở mọi request: `res.locals.admin`, flash, `currentQuery` (query string, để partial phân trang dựng liên kết) |

## 3. Thành phần giao diện sẵn có

* **Bảng:** `.card > .card-header > h2`, `.table-wrapper > table`; ô trống là một hàng `<td colspan class="text-center">`. Huy hiệu `badge badge-primary|success|warning|danger|info` (và `badge-secondary` được dùng nhưng **chưa có kiểu**, P8 thêm).
* **Bộ lọc:** một `.card` chứa `<form method="GET">` với `.form-group` (nhãn nhỏ 12px) và nút Filter / Clear Filters; giá trị lọc đọc từ `req.query` rồi truyền lại view qua biến `filters`.
* **Biểu mẫu:** `<form method="POST">` bình thường, kiểm hợp lệ trong controller, lỗi qua flash rồi `res.redirect` (kiểu *post/redirect/get*).
* **Phân trang:** `helpers/pagination.ts` (`paginate(query, countQuery, params, countParams, page, limit)` trả `{ rows, total, page, limit, totalPages }`; mặc định 20 dòng) và `views/partials/pagination.ejs` (nhận `pagination`, dùng `currentQuery`). Liên kết dạng `?page=N` giữ các tham số lọc khác.
* **Hộp thoại xác nhận:** thẻ `<dialog>` gốc của trình duyệt (xóa mục từ).

## 4. Cách gọi API từ trang

Gần như không có. Trang quản trị chủ yếu gửi form. Chỉ hai chỗ dùng AJAX:

| Chỗ | Cách làm |
|---|---|
| `GET /dictionary?format=json` (ô tìm mục từ khi thêm vào bài học / bộ thẻ) | trả `{ entries: [...] }` thô, **không có** vỏ `{ success, data }` |
| `POST /decks/:id/reorder` | thân JSON `{ direction }`; lỗi trả `{ success: false, error: { code, message } }` **viết tay** (đúng dạng của `apiError`); thành công `204` |

## 5. Quy ước đặt tên

* Controller: object với các hàm `getIndex`, `getShow`, `getEdit`, `postEdit`, `postDelete`, …; mỗi hàm `try { … } catch (err) { console.error('[Tên] hàm error:', err); req.flash('error', …); return res.redirect(…); }`. Xuất bằng `export =`.
* Model: hàm SQL mỏng (`pool.query`), không ORM, không luật nghiệp vụ.
* Biến truyền view: `title`, `active` (tên mục sidebar sáng lên), `filters`, `pagination`, danh sách.
* JSON: snake_case (CLAUDE.md), vỏ `apiSuccess` / `apiError` ở `utils/apiResponse.ts` (thứ tự đối số `(res, statusCode, code, message)`).

## 6. Màn hình sửa mục từ hiện có (`/dictionary/:id/edit`)

* Form POST tới `DictionaryEntry.update(id, data, tagIds)` trong một transaction: ghi `dictionary_entries` (headword và lemma **bị hạ chữ thường**), xóa rồi ghi lại `entry_tags`.
* **Chỉ sửa trường cấp mục từ**: headword, lemma, IPA, audio, loại từ, `meaning_vi`, `meaning_en`, ví dụ đầu, CEFR, hạng tần suất, nguồn, ghi chú admin, xuất bản, chủ đề. **Không có trường nào cho `entry_senses`, `sense_examples`, `word_forms`, đồng nghĩa, thành ngữ…** Nghĩa tiếng Việt của **từng sense** (cái mà app hiển thị trước tiên) không sửa được ở đây.
* **Không ghi `entry_edit_history`** (trước P8: không có đoạn mã web nào ghi bảng này; chỉ job làm giàu, `backfillIpa` và script seed ghi).
* Vai trò được vào: `super_admin`, `moderator` (không có `content_editor`).

## 7. Kiểm thử trang quản trị hiện có

Không có. `tests/` chỉ có test API di động (JWT) và test của luồng tra từ. Chưa test nào đăng nhập bằng `POST /auth/login` hay vẽ một trang EJS. P8 thêm cách làm: `supertest` + `request.agent(app)` đăng nhập thật bằng tài khoản `admin_accounts` tạo cho từng vai trò (`tests/helpers/lookupAdminFixtures.ts`), kiểm HTML trả về.

## 8. Dữ liệu và công cụ P8 dùng lại

`LookupHealthService.getSnapshot()` (`services/lookup/health.ts`), `EnrichmentEnqueuer` (`services/queue/pgBossEnqueuer.ts`, qua `getEnrichmentEnqueuer()` mới xuất ra ở `services/lookup/index.ts`), `models/EnrichmentJob.ts`, `utils/redact.ts` (che khóa trong log), `services/queue/log.ts` (`logEvent`), `helpers/pagination.ts`, `utils/apiResponse.ts`, `utils/asyncHandler.ts`.

## 9. P8 bám theo thế nào

| Việc | Cách làm | Vì sao |
|---|---|---|
| Mount | một mount mới `/lookup` (`routes/lookup.ts` + hai controller) | mỗi miền một mount, đúng như các miền khác |
| Trang | EJS dựng ở máy chủ, bộ lọc là query string, phân trang bằng `paginate` + partial có sẵn | cùng kiểu với `dictionary/index.ejs` |
| Điều khiển | các nút gọi **JSON** dưới `/lookup/api/*` bằng `fetch` (`public/js/lookup-admin.js`, JS thuần) | yêu cầu của P8 là có API riêng; hai ví dụ AJAX có sẵn cũng là JSON |
| Chặn quyền | trang: `requireAuth` + `requireRole` có sẵn (chuyển hướng). API: `requireAdminJson` mới (`middlewares/adminJson.ts`), cùng phiên và cùng vai trò nhưng trả `401 UNAUTHORIZED` / `403 FORBIDDEN` dạng JSON | `fetch` không dùng được trang chuyển hướng |
| JSON | vỏ `apiSuccess` / `apiError`, trường snake_case, mã lỗi in hoa. **Riêng `GET /lookup/api/health` giữ nguyên khóa camelCase của `getSnapshot()`** (cùng nội dung với `npm run health:snapshot`, để một thứ chỉ có một dạng) | CLAUDE.md; ngoại lệ ghi ở đây |
| Mã lỗi mới (chỉ của bề mặt quản trị, không thuộc hợp đồng với app di động) | `UNAUTHORIZED` 401, `JOB_NOT_RETRYABLE` 409, `WORD_ALREADY_ACTIVE` 409, `ENRICHMENT_DISABLED` 409, `QUEUE_UNAVAILABLE` 503 | |
| Giao diện | tiếng Việt; thêm một mục sidebar có ba mục con; CSS thêm vào cuối `style.css` (tiền tố `lk-`), thêm `.badge-secondary` và `.alert-warning` còn thiếu | không thư viện mới |
| Nhật ký | `logEvent('…', 'admin_action', …)` qua `utils/adminAudit.ts` | cùng cách ghi log của lớp hàng đợi |

## 10. Điều thấy trong lúc khảo sát

### 10.1 Đã sửa vì làm hỏng luồng duyệt của P8

1. **Bỏ chọn "Published" trong màn sửa lại thành XUẤT BẢN.** `DictionaryEntry.update` tính `published = data.published !== false && data.published !== 'false'`; ô chưa chọn không gửi trường nào (`undefined`), mà `undefined` được tính là đúng. Hệ quả: mở mục từ **chờ duyệt** bằng nút Sửa rồi Lưu là xuất bản nó ngay, không qua bước duyệt và không có lịch sử; và không có cách ẩn mục từ từ màn sửa. **Đã sửa** (`models/DictionaryEntry.ts`): chọn → công khai, không chọn → ẩn. Cùng lỗi ở `DictionaryEntry.create` (ô bỏ chọn khi tạo vẫn công khai) **chưa sửa** vì không nằm trên đường của P8.
2. **Màn sửa không có chỗ ghi lịch sử.** Nay đổi `published` ở màn sửa cũng ghi `entry_edit_history` (`field_name = 'published'`, admin thao tác) trong cùng transaction. Các trường khác vẫn không ghi lịch sử (như cũ).
3. **Màn sửa làm rơi loại từ ngoài danh sách cố định.** Danh sách ô chọn chỉ có 10 giá trị; job làm giàu có thể ghi `exclamation`, `modal verb`, `number`, `article`. Lưu form làm mất các giá trị đó. **Đã sửa** (`views/dictionary/edit.ejs`): loại từ mà mục từ đang có nhưng không nằm trong danh sách vẫn được vẽ và đánh dấu.
4. **`content_editor` không vào được `/dictionary`.** Nút Sửa của trang duyệt vô dụng với họ. **Đã mở** `GET /dictionary/:id`, `GET` và `POST /dictionary/:id/edit` cho `content_editor` (thêm vai trò vào danh sách của đúng ba đường đó); danh sách, tạo, nhập, xóa vẫn chỉ `super_admin` và `moderator`. Muốn hoàn tác: sửa lại `routes/dictionary.ts` (một biến `editors`).

### 10.2 Chưa sửa, cần bạn biết

1. **Màn sửa hiện có không sửa được nghĩa của từng sense** (mục 6): người duyệt thấy một nghĩa sai trong trang duyệt nhưng phải sửa bằng SQL, hoặc xuất bản rồi chấp nhận. Cần một thao tác sửa `entry_senses.definition_vi` (việc của P8b nếu bạn muốn).
2. **Không có bảo vệ CSRF.** Mọi POST của trang quản trị (cũ và mới) dựa vào cookie phiên không đặt `sameSite`. Trình duyệt mặc định `Lax` (Chrome) chặn phần lớn trường hợp, nhưng không phải trình duyệt nào cũng vậy, và `cors()` mở cho mọi nguồn. Điểm mới của P8: các điểm cuối JSON chỉ nhận thân `application/json` (một form chéo trang không gửi được), nhưng `fetch` chéo trang có cookie sẽ qua nếu trình duyệt gửi cookie. Cách vá gọn: `sameSite: 'lax'` cho cookie phiên (và `secure: true` ở production) cộng kiểm `Origin` ở các POST.
3. **Vai trò chụp lúc đăng nhập** (mục 2): hạ vai trò một admin từ `content_editor` xuống `moderator` không chặn được họ ngay. API của P8 dùng vai trò trong phiên như mọi chỗ khác.
4. **`moderator` vẫn sửa được mục từ qua `/dictionary/:id/edit`** (quyền có từ trước). P8 chỉ ẩn nút Sửa với họ ở trang duyệt; muốn chặn hẳn phải bỏ `moderator` khỏi hai đường sửa.
5. **Phiên nằm trong bộ nhớ**: mỗi lần triển khai lại là mọi admin phải đăng nhập lại; không dùng được khi chạy nhiều bản sao ứng dụng.
