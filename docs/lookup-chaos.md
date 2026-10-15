# WordyGo · Kịch bản chịu lỗi (`npm run test:chaos`)

Mục tiêu (P7): có bằng chứng chạy được rằng khi một nguồn **lỗi, chậm hoặc hết ngân sách** thì hệ thống hỏng **có kiểm soát**: trả đúng mã theo ma trận §6, không treo, không mất job, không sập tiến trình. Đặc tả: `docs/lookup-spec.md` §11. Cách vận hành: `docs/lookup-runbook.md`.

Các test nằm ở `tests/chaos/*.chaos.test.ts`, **không** chạy trong `npm test` (chậm: chờ mạch ngắt reset, chờ pg-boss phát hiện tiến trình chết, cron thật). Cấu hình: `jest.chaos.config.js`. Mỗi lần chạy cần Postgres thật (DB dev trong `.env`); pg-boss chạy trong schema riêng `pgboss_test_<loại>_<mã>` (xóa khi xong); dữ liệu thử là `qzq<mã>…`. Không gọi dịch vụ thật: nguồn ngoài là máy chủ giả (`scripts/mock-upstream`), Anthropic là SDK giả ném đúng lớp `Anthropic.APIError`; trong các test dùng ứng dụng thật, `fetch` toàn cục từ chối mọi máy chủ không phải loopback.

| Tệp | Kịch bản | Điều được chứng minh |
|---|---|---|
| `upstream.chaos.test.ts` | Google trả 500 liên tiếp | mạch mở sau đúng `UPSTREAM_BREAKER_FAILURE_THRESHOLD` lần; các request sau **không gọi Google** (số request ở máy chủ giả đứng yên), bản trả vẫn 200 `partial`; sau `UPSTREAM_BREAKER_RESET_MS` nửa mở và để **đúng một** request thử; thử thất bại thì mở lại; thử thành công thì đóng và Google được gọi lại. Free Dictionary vẫn chạy suốt |
| | Free Dictionary 429 (có và không có `Retry-After`) | trả 200 `partial` (G và FDerr), ghi `fd: error:rate_limited`; ba lỗi liên tiếp mở **mạch của nó** còn mạch Google đóng |
| | Hết token bucket nội bộ (`FREE_DICTIONARY_MAX_REQUESTS_PER_5MIN=3`) | request thứ tư trở đi **không ra ngoài**, kết quả `partial`, `fd: error:local_rate_limit`, mạch không bị đụng tới |
| | Hết ngân sách ký tự Google (999 / 1000) | bản tạm thiếu nghĩa tiếng Việt, **Google không được gọi**, bộ đếm không bị trừ, mạch không mở; từ Free Dictionary cũng không biết thì 404 |
| | Vượt trần job ngày (`ENRICHMENT_MAX_JOBS_PER_DAY=2`) qua enqueuer thật | từ thứ ba: `enrichment: { status: "skipped", reason: "daily_cap" }`, không có job; câu trả lời tra từ vẫn đầy đủ |
| | Datamuse trả 503, 429, treo (hết thời gian), HTML | job **vẫn `succeeded`**, bản nháp chỉ thiếu ứng viên đồng/trái nghĩa; Datamuse bình thường thì có ứng viên |
| `anthropic.chaos.test.ts` | 429 có `retry-after: 2` | worker **chờ** đủ thời gian đó (rồi backoff của pg-boss) trước khi thử lại; ngay lần thử hai thành công; khoảng cách hai lần gọi ≥ 2 s |
| | 429 không `retry-after`; 529 hai lần | thử lại bằng backoff; lần thứ ba thành công |
| | 529 mãi | hết lần thử → `failed / upstream_error`, job vào hàng chết |
| | 429 `enforced_spend_limit_reached`; HTTP 400 "You have reached your specified API usage limits…" | `skipped / budget`, **gọi đúng 1 lần**, job pg-boss hoàn tất (không thử lại), không vào hàng chết, mạch mở ngay, log mức error; job kế tiếp không gọi Anthropic |
| | 401 | `failed / config_error`, không thử lại |
| `db.chaos.test.ts` | kết nối bị `pg_terminate_backend` giữa giao dịch của job (như S6) | lỗi được coi là tạm thời: hàng về `queued`, pg-boss thử lại, lần hai `succeeded`; không hàng nào kẹt `queued`/`running` |
| | một lần ghi kết quả vào sổ thất bại | kết quả không mất: job chạy lại và hoàn tất |
| | **mọi** kết nối (pool ứng dụng và pool riêng của pg-boss) bị ngắt khi job đang chạy | không sập; job tới trạng thái cuối, job pg-boss `completed`, không hàng treo |
| `process.chaos.test.ts` | tiến trình worker (con thật) được yêu cầu dừng khi đang chạy job | hàng về `queued`, job pg-boss ở `retry`, **worker khác nhận và hoàn tất** (`attempts` = 2) |
| | tiến trình worker bị `SIGKILL` | không ai dọn được; sau khi hết hạn (`expireInSeconds`) pg-boss của máy khác thử lại, hàng sổ về `succeeded`, không hàng treo |
| | job pg-boss mất hẳn | bộ dọn đặt hàng sổ thành `failed / stale` |
| `schedule.chaos.test.ts` | hai thực thể pg-boss cùng đánh giá cron `* * * * *` | cron thật bắn tự động; **mỗi phút đúng một lần chạy** trên cả hai thực thể |

Mô hình lỗi ở mức DB là thật (`pg_terminate_backend` trên kết nối của chính test: mỗi test dùng `application_name` có mã chạy, nên tiến trình của người khác trên DB dev không bị đụng tới).

## Ghi chú kỹ thuật

* Windows không có handler `SIGTERM` cho tiến trình con, nên test dừng "lịch sự" gửi tin nhắn IPC `shutdown` chạy đúng các bước của `worker.ts` (dừng pg-boss có ân hạn, đặt lại hàng, đóng pool); dừng đột ngột dùng `child.kill('SIGKILL')`.
* Test DB dựng pool riêng và gắn `attachPoolErrorHandlers` (như `config/db.ts`). Khi viết kịch bản này đã lộ một lỗi thật: client lấy từ pool ra (`pool.connect()`) **không có listener lỗi** và việc DB cắt kết nối giữa giao dịch là một sự kiện `error` không ai nghe → ngoại lệ không bắt được → sập tiến trình. Đã vá trong `config/poolErrors.ts` (xem `docs/lookup-audit.md` mục 4). `tests/db/poolError.test.ts` giữ cho lỗi đó không quay lại.
