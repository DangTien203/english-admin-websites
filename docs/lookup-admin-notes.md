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

1. **Bỏ chọn "Published" trong màn sửa lại thành XUẤT BẢN.** `DictionaryEntry.update` tính `published = data.published !== false && data.published !== 'false'`; ô chưa chọn không gửi trường nào (`undefined`), mà `undefined` được tính là đúng. Hệ quả: mở mục từ **chờ duyệt** bằng nút Sửa rồi Lưu là xuất bản nó ngay, không qua bước duyệt và không có lịch sử; và không có cách ẩn mục từ từ màn sửa. **Đã sửa** (`models/DictionaryEntry.ts`): chọn → công khai, không chọn → ẩn. Cùng lỗi ở `DictionaryEntry.create` (ô bỏ chọn khi tạo vẫn công khai) **đã sửa ở P9** (mục 11).
2. **Màn sửa không có chỗ ghi lịch sử.** Nay đổi `published` ở màn sửa cũng ghi `entry_edit_history` (`field_name = 'published'`, admin thao tác) trong cùng transaction. Các trường khác vẫn không ghi lịch sử (như cũ).
3. **Màn sửa làm rơi loại từ ngoài danh sách cố định.** Danh sách ô chọn chỉ có 10 giá trị; job làm giàu có thể ghi `exclamation`, `modal verb`, `number`, `article`. Lưu form làm mất các giá trị đó. **Đã sửa** (`views/dictionary/edit.ejs`): loại từ mà mục từ đang có nhưng không nằm trong danh sách vẫn được vẽ và đánh dấu.
4. **`content_editor` không vào được `/dictionary`.** Nút Sửa của trang duyệt vô dụng với họ. **Đã mở** `GET /dictionary/:id`, `GET` và `POST /dictionary/:id/edit` cho `content_editor` (thêm vai trò vào danh sách của đúng ba đường đó); danh sách, tạo, nhập, xóa vẫn chỉ `super_admin` và `moderator`. Muốn hoàn tác: sửa lại `routes/dictionary.ts` (một biến `editors`).

### 10.2 Chưa sửa, cần bạn biết

1. **Màn sửa hiện có không sửa được nghĩa của từng sense** (mục 6) — **đã làm ở P9**: màn chi tiết của trang duyệt có thao tác sửa nghĩa tiếng Việt và bản dịch ví dụ của từng sense, có kiểm tra đầu vào và dấu vết trong `entry_edit_history` (`docs/lookup-admin.md` mục 3.3, mục 11 dưới đây).
2. **Không có bảo vệ CSRF.** Mọi POST của trang quản trị (cũ và mới) dựa vào cookie phiên không đặt `sameSite`. Trình duyệt mặc định `Lax` (Chrome) chặn phần lớn trường hợp, nhưng không phải trình duyệt nào cũng vậy, và `cors()` mở cho mọi nguồn. Điểm mới của P8: các điểm cuối JSON chỉ nhận thân `application/json` (một form chéo trang không gửi được), nhưng `fetch` chéo trang có cookie sẽ qua nếu trình duyệt gửi cookie. Cách vá gọn: `sameSite: 'lax'` cho cookie phiên (và `secure: true` ở production) cộng kiểm `Origin` ở các POST.
3. **Vai trò chụp lúc đăng nhập** (mục 2): hạ vai trò một admin từ `content_editor` xuống `moderator` không chặn được họ ngay. API của P8 dùng vai trò trong phiên như mọi chỗ khác.
4. **`moderator` vẫn sửa được mục từ qua `/dictionary/:id/edit`** (quyền có từ trước) — **đã khép ở P9 và P8c**: họ vẫn sửa các trường khác, nhưng không đổi được `published` nữa, ở cả màn sửa (P9) lẫn màn tạo mới (P8c): ô bị khóa, giá trị bị bỏ qua và ghi log; xem mục 11 và 12.
5. **Phiên nằm trong bộ nhớ**: mỗi lần triển khai lại là mọi admin phải đăng nhập lại; không dùng được khi chạy nhiều bản sao ứng dụng.

## 11. P9: những gì đã làm và vì sao

Ngày 16/10/2026. Sáu việc, cùng một nguyên tắc: **không đổi ma trận mục 6 và không đổi hành vi tra cứu**; chỉ trang quản trị, trình sửa mục từ và công cụ.

| # | Việc | Làm gì | Quyết định cần biết |
|---|---|---|---|
| 1 | Xuất bản hàng loạt không chọn được mục nào | Xếp mỗi ghi chú của Haiku vào một nhóm; chỉ nhóm "cần xem" chặn (`services/lookup/reviewNotes.ts`, bảng nhóm là hằng số). Hộp xác nhận hiện số mục và 5 mục ngẫu nhiên | 23 trong 41 mục từ `[auto]` đủ điều kiện (trước đó 0). Bảng nhóm và số liệu: `docs/lookup-admin.md` mục 3.4 |
| 2 | Không sửa được nghĩa từng sense | `PATCH /lookup/api/auto-entries/:id/senses/:senseId` và nút sửa tại chỗ ở màn chi tiết; làm sạch và kiểm tra đầu vào; `entry_edit_history` ghi sense, văn bản cũ và mới, người sửa | Chỉ `definition_vi` của sense và `example_vi` của ví dụ thuộc sense đó. `entry_answer_aliases` và `meaning_vi` cấp mục từ không tự sinh lại |
| 3 | `DictionaryEntry.create` xuất bản khi bỏ tick | Tick = công khai, bỏ tick = ẩn (đúng như `update` đã sửa ở P8) | Trang tạo mới vẫn vẽ ô đã tick sẵn nên cách tạo thông thường vẫn công khai |
| 4 | `moderator` đổi `published` qua `POST /dictionary/:id/edit` | Chỉ `super_admin` và `content_editor` đổi được; với vai trò khác ô bị khóa, giá trị gửi lên bị bỏ qua và (nếu khác trạng thái hiện tại) ghi log `admin_action` / `dictionary.edit.published` | Lúc đó chưa áp cho `POST /dictionary/create`. **Đã áp ở P8c** (mục 12) |
| 5 | Jest quét `.claude/worktrees` | `.claude/` đã nằm trong `testPathIgnorePatterns` và `modulePathIgnorePatterns` của `jest.config.js` (và của cấu hình chaos); `.claude/worktrees/` đã nằm trong `.gitignore` | Cả hai đã được làm trước P9; P9 kiểm lại `npm test` mặc định xanh |
| 6 | Mật khẩu mặc định trong `CLAUDE.md` | Xóa mục "Default local admin" (và cùng mục trong `AGENTS.md`); thay bằng ghi chú không có thông tin đăng nhập | Xem bên dưới |

**Về tài khoản quản trị.** Repo chỉ có một cách tạo tài khoản quản trị ngoài trang đăng nhập: `npm run db:seed` (`scripts/seed.ts`). Nó **xóa sạch nhiều bảng trước** rồi tạo 10 tài khoản quản trị (và 100 người dùng) với **một mật khẩu cố định** ghi trong chính script, và mật khẩu đó **không phải** `admin123` như `CLAUDE.md` từng ghi. Tôi không chạy nó và không tạo tài khoản nào với mật khẩu cố định. `README.md` lúc đó vẫn có mật khẩu `admin123` (4 chỗ) và `AGENTS.md` có cùng mục như `CLAUDE.md` (đã xóa). **Cả hai đã xong ở P8c** (mục 12): `README.md` không còn mật khẩu nào và có `npm run admin:create` để tạo MỘT tài khoản với mật khẩu ngẫu nhiên in ra một lần. Các test tạo tài khoản riêng với tên ngẫu nhiên và xóa sau khi chạy (`tests/helpers/lookupAdminFixtures.ts`).

## 12. P8c: dọn nhỏ trước P9 và những gì đã làm

Không đổi spec, không chạy `db:seed`, không xóa dữ liệu nào, không chạy script dọn với `--confirm`.

| # | Việc | Làm gì | Quyết định cần biết |
|---|---|---|---|
| 1 | `admin123` trong `README.md` và không có cách tạo admin an toàn | Xóa cả 4 chỗ. Thêm `npm run admin:create -- --email <e> --name <n>` (`scripts/admin/create-admin.ts`): thêm MỘT `super_admin`, mật khẩu ngẫu nhiên 24 ký tự in ra đúng một lần, hoặc đọc từ `ADMIN_PASSWORD` (khi đó không in). `README.md` trỏ tới script | Chỉ `SELECT` rồi một `INSERT`; không xóa bảng nào, không đổi tài khoản nào; từ chối e-mail đã có (kể cả khác hoa thường, kể cả khi hai lệnh chạy cùng lúc nhờ chỉ mục duy nhất). Từ chối mật khẩu qua dòng lệnh (lộ trong lịch sử shell). Mật khẩu từ môi trường phải từ 12 ký tự và không quá 72 byte (bcrypt không đọc quá). Mã thoát: 0 xong, 1 từ chối / lỗi, 2 dùng sai |
| 2 | `scripts/seed.ts` xóa nhiều bảng không hỏi | Chốt an toàn `scripts/seedGuard.ts`, gọi **trước khi mở kết nối**: in cơ sở dữ liệu sắp dùng (host và tên, không mật khẩu) và danh sách 32 bảng sẽ xóa; từ chối nếu `NODE_ENV=production` hoặc host không phải `localhost` / `127.x.x.x` / `::1` / `*.localhost`, trừ khi có `--i-know-this-wipes-tables` | Đọc cùng biến với `config/db.ts` (`DATABASE_URL` nếu là URL postgres, nếu không thì `DB_HOST`/`DB_NAME`). URL không đọc được thì coi là KHÔNG phải máy này. Tên miền chỉ bắt đầu bằng `localhost` (ví dụ `localhost.evil.com`) không phải máy này. Tôi kiểm thử bằng hàm thuần và đọc thứ tự trong mã nguồn, không chạy seed. Hai chỗ nguy hiểm tương tự (`npm run db:reset` / `db:fresh` và `scripts/seed-mobile-test-users.ts`) lúc đó chưa được bảo vệ; **đã làm ở P8d** (mục 13) |
| 3 | `POST /dictionary/create` cho moderator chọn công khai ngay | Cùng luật như `POST /dictionary/:id/edit`: người không có quyền xuất bản (moderator) tạo mới thì `published` luôn là `false` bất kể ô tick; nếu họ đã tick thì ghi `admin_action` / `dictionary.create.published` kết quả `forbidden` (`requested: true, kept: false`). Trang tạo vẽ ô bị khóa, bỏ tick, kèm lý do; sau khi lưu có ghi chú "ẩn" | `super_admin` không đổi (tick = công khai). Người tạo vẫn là moderator. `content_editor` vẫn không vào được `/dictionary/create` (route chỉ cho `super_admin`, `moderator`), nên không có đường vòng. Lúc không tick không có gì để từ chối nên không ghi log |
| 4 | Dọn mục từ `[auto]` thử nghiệm | `scripts/dev/cleanup-auto-entries.ts`, mặc định chỉ LIỆT KÊ; xem phần dưới | Xóa duy nhất khi có đúng cờ `--confirm` |

**Script dọn `[auto]` (`npx tsx scripts/dev/cleanup-auto-entries.ts`).**

* Tiêu chí `[auto]` đúng với màn `/lookup/review` (`admin_note LIKE '[auto]%'`, cùng hằng `AUTO_NOTE_PREFIX`); câu `DELETE` lặp lại điều kiện này nên không bao giờ xóa mục không phải `[auto]` (845 mục, gồm Oxford, không bị đụng).
* Chạy thử: kế hoạch được lập trong giao dịch `READ ONLY` rồi `ROLLBACK` (chính cơ sở dữ liệu từ chối mọi lệnh ghi). In từng mục sẽ xóa, số mục đang published, số hàng sẽ xóa ở từng bảng liên quan, số hàng giữ lại nhưng bị đặt `NULL`, và các mục bị bỏ qua cùng lý do.
* `--confirm`: MỘT giao dịch; khóa các mục (`FOR UPDATE`), lập lại kế hoạch trong giao dịch, `DELETE` đúng một lệnh, và nếu số hàng báo về khác kế hoạch thì `ROLLBACK` toàn bộ; xong in số hàng đã xóa. Lỗi ở bất kỳ bước nào kể cả `COMMIT` thì không xóa gì. Tùy chọn lạ (`--confirmed`, `--yes`, `--force`…) bị từ chối với mã 2, không chạy.
* Bảng liên quan được đọc từ danh mục cơ sở dữ liệu (`pg_constraint`), không liệt kê tay, nên một bảng thêm sau này cũng được đếm và, nếu không phải dữ liệu của chính mục từ, sẽ khiến mục từ bị bỏ qua thay vì bị xóa lặng lẽ.
* **Bỏ qua và báo** mục `[auto]` đang nằm trong `lesson_entries`, là `entry_synonyms.synonym_id` hoặc `entry_antonyms.antonym_id` của mục KHÁC (liên kết của chính nó thì đi cùng nó), hoặc được dữ liệu ngoài mục từ trỏ tới (từ đã lưu, thẻ Leitner, bộ thẻ, danh sách trò chơi, họ từ…). Bỏ qua có thể dây chuyền: mục là từ đồng nghĩa của một mục bị bỏ qua cũng bị bỏ qua.
* Đi theo mục từ: nghĩa, ví dụ, thẻ, dạng từ, thành ngữ, cụm động từ, collocation, lịch sử sửa, bí danh đáp án và bộ nhớ đệm chấm điểm, liên kết đồng/trái nghĩa của chính nó, và nhật ký tra từ (`word_lookups`) trỏ tới nó. Giữ lại và đặt `NULL`: `word_enrichment_jobs.entry_id`, liên kết "đồng nghĩa với" / "trái nghĩa với" ở sense của mục khác.

**Kết quả chạy thử trên DB dev (không `--confirm`).** 41 mục `[auto]` (0 đang published), 845 mục khác không đụng. **38 sẽ xóa**, **3 bị bỏ qua**: `batter`, `bolt`, `sage`, mỗi mục có 1 dòng `word_family_members`. Hàng sẽ xóa kèm theo: `entry_senses` 153, `sense_examples` 188, `sense_synonyms` 318, `sense_antonyms` 64, `word_forms` 162, `entry_tags` 87, `entry_answer_aliases` 105, `entry_edit_history` 45, `collocations` 29, `entry_synonyms` 24, `word_lookups` 6, `entry_idioms` 3, `phrasal_verbs` 3, `entry_antonyms` 2; `word_enrichment_jobs.entry_id` 31 dòng giữ lại và đặt `NULL`. Số có thể đã đổi khi bạn đọc dòng này: chạy lại để lấy số mới.

Test: `tests/scripts/adminCreate.test.ts`, `tests/scripts/seedGuard.test.ts`, `tests/scripts/cleanupAutoEntries.test.ts` (mục từ thử gắn `qzq<mã>`, phạm vi thu hẹp bằng tham số `onlyIds` của thư viện, dòng lệnh thật không có tham số này nên 41 mục thật không bị đụng) và khối "a moderator creating an entry" trong `tests/admin/dictionaryEditor.test.ts`.

## 13. P8d: chốt an toàn cho `db:reset` và `seed-mobile-test-users`

Cùng nguyên tắc mục 12 (việc 2): in cơ sở dữ liệu sắp dùng và những gì sẽ bị xóa **trước khi mở kết nối**, từ chối nếu `NODE_ENV=production` hoặc host không phải máy này, trừ khi có cờ tường minh. Một cài đặt dùng chung: `guardWipe` trong `scripts/seedGuard.ts`; `guardSeed` (không đổi lời nhắn, 30 test cũ của `seedGuard.test.ts` không sửa), `guardReset` và `guardTestUsers` chỉ dựng lời nhắn riêng. Không chạy `db:reset`, `db:fresh` hay `db:seed` trong đợt này.

| # | Việc | Làm gì | Quyết định cần biết |
|---|---|---|---|
| 1 | `database/reset.ts` (`db:reset`, nửa đầu của `db:fresh`) | `guardReset` gọi đầu hàm `reset()`, trước `pool.connect()` và trước mọi `DROP`; cờ `--i-know-this-wipes-tables`. Danh sách bảng cụ thể chưa biết khi chưa kết nối ("mọi bảng của schema public trừ 15 bảng nội dung từ điển"; với `--all` thì không trừ bảng nào), nên lời nhắn đầu nói đúng quy tắc đó và kèm 15 bảng được giữ; **sau khi kết nối và trước khi xóa**, `reset.ts` in danh sách bảng thật sự sắp bị xóa (cả hai chế độ) | `reset()` chỉ chạy khi tệp là chương trình được khởi động (`require.main === module`), nên import nó không xóa gì. Từ chối thoát mã 1, nên `db:fresh` (`reset && seed`) dừng trước khi seed chạy. **`db:fresh` không chuyển được cờ cho nửa reset** (npm chỉ đưa tham số thêm cho lệnh cuối): trên cơ sở dữ liệu không nằm trên máy này phải chạy `db:reset -- <cờ>` rồi `db:seed -- <cờ>` thành hai lệnh. Tôi không đổi `package.json` |
| 2 | `scripts/seed-mobile-test-users.ts` | `guardTestUsers` là việc đầu tiên của `main()`, trước `pool.connect()`; in 6 e-mail sẽ bị ghi đè. Cờ riêng `--i-know-this-sets-a-known-password` (không dùng cờ `wipes-tables` vì script không xóa bảng nào, mà đặt mật khẩu cố định và xóa dữ liệu học của 6 tài khoản đó) | Mật khẩu cố định **không đổi** và lời nhắn **không in** nó. Rủi ro thật: `ON CONFLICT (email) DO UPDATE` đặt lại mật khẩu của tài khoản đã tồn tại với một trong 6 e-mail đó, sau khi đã xóa dữ liệu của họ; trên cơ sở dữ liệu có người dùng thật, đó là chiếm tài khoản. Cờ của script này không mở được `db:reset`/`db:seed` và ngược lại |

Test: `tests/scripts/wipeGuards.test.ts` (34 test). Các hàm chốt là hàm thuần; thứ tự dòng trong `reset.ts` và `seed-mobile-test-users.ts` được kiểm bằng đọc văn bản (chốt trước `connect`, trước `DROP`/`DELETE`, có `process.exit(1)`, danh sách in trước khi xóa, không có lệnh gọi trần ở cấp tệp). Ngoài ra 8 test **khởi động chính các tệp thật** (`reset.ts` hai chế độ, `seed.ts`, `seed-mobile-test-users.ts`) như tiến trình con với `DATABASE_URL` trỏ tới host `.invalid` (không bao giờ phân giải) hoặc `localhost:1` kèm `NODE_ENV=production`, và yêu cầu: mã thoát 1, có `TỪ CHỐI`, không có lỗi mạng nào trong đầu ra (nghĩa là chưa hề cố kết nối), không in mật khẩu. Dù chốt hỏng, tiến trình con cũng không với tới được cơ sở dữ liệu nào.
