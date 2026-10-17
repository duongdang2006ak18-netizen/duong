# OVR CLUB — cửa hàng tài khoản FC Mobile VN

Ứng dụng gồm trang cửa hàng, cơ sở dữ liệu SQLite, màn hình quản trị, tài khoản khách, lịch sử đơn hàng, vòng quay acc trả bằng điểm và thanh toán chuyển khoản xác nhận thủ công. Không có acc mẫu; quản trị viên tự thêm hàng tồn kho.

## Chạy trên Windows

1. Cài Node.js **22.13 trở lên** từ [nodejs.org](https://nodejs.org/).
2. Mở PowerShell tại thư mục dự án và chạy:

   ```powershell
   .\Start-Store.ps1
   ```

3. Ở lần đầu, nhập tên/mật khẩu quản trị và thông tin tài khoản ngân hàng nhận tiền. Mật khẩu phải dài tối thiểu 12 ký tự.
4. Mở [http://localhost:3000](http://localhost:3000). Trang quản trị ở [http://localhost:3000/admin.html](http://localhost:3000/admin.html).
5. Đăng nhập trang quản trị, thêm tài khoản FC Mobile còn hàng. Mỗi acc có thể có tối đa 5 ảnh JPG, PNG hoặc WebP (tối đa 5 MB mỗi ảnh); với acc đã có trong kho, dùng nút **THÊM ẢNH** trong danh sách kho. Khách có thể bấm vào sản phẩm để xem từng ảnh; quản trị viên cũng có thể xóa từng ảnh trong danh sách kho. Ảnh được lưu trong `product-images`. Thông tin đăng nhập acc chỉ được trả cho khách có mã đơn và số điện thoại khớp sau khi quản trị viên xác nhận đã nhận tiền.
6. Khách cần đăng nhập hoặc tạo tài khoản trước khi đặt mua. Dùng nút **Tài khoản** trên trang shop; tên đăng nhập dài 3–32 ký tự (chữ không dấu, số, `.`, `_`, `-`), mật khẩu tối thiểu 12 ký tự. Khi tạo đơn, đơn tự lưu vào lịch sử tài khoản. Các đơn cũ có thể liên kết bằng mã đơn và số điện thoại đặt hàng. Lịch sử chỉ hiện thông tin đăng nhập acc sau khi đơn được xác nhận đã thanh toán.
7. Vòng quay nằm trong mục **Thử vận may**. Một điểm tương ứng 1.000đ; các gói nạp là 10.000đ/10 điểm, 20.000đ/20 điểm, 50.000đ/50 điểm và 100.000đ/100 điểm; mỗi lượt tốn 10 điểm. Khách tạo mã nạp, chuyển khoản QR rồi chờ quản trị viên kiểm tra giao dịch và duyệt trong mục **YÊU CẦU NẠP ĐIỂM**. Mỗi tài khoản chỉ có thể có một yêu cầu nạp đang chờ duyệt. Trong trang quản trị, chọn các acc còn hàng ở mục **CÀI ĐẶT GIẢI VÒNG QUAY**, đặt tỷ lệ tổng đúng 100% (tối đa 2 chữ số thập phân) và lưu. Tỷ lệ được công khai; kết quả quay được chọn phía máy chủ, mỗi lượt trúng một giải, acc trúng được đánh dấu đã bán và thông tin đăng nhập lưu trong lịch sử vòng quay của khách. Khi giải hết hàng, các tỷ lệ giải còn lại được chuẩn hóa lại và công khai. Hãy kiểm tra các quy định áp dụng cho chương trình quay thưởng có thu tiền trước khi mở cho khách.

Trong lần cài Node.js đầu tiên, nếu PowerShell đang mở từ trước, lệnh `Start-Store.ps1` tự tìm Node trong winget. Nếu Node vừa được cài mà PowerShell chưa nhận `npm`, hãy mở cửa sổ PowerShell mới trước khi chạy.

Tạo đơn giữ acc trong 24 giờ. Khách chuyển khoản theo mã QR/thông tin hiển thị; quản trị viên cần tự kiểm tra giao dịch trong ứng dụng ngân hàng rồi bấm **Đã nhận tiền**. Không xác nhận chỉ dựa trên ảnh chụp chuyển khoản.

## Dữ liệu và an toàn

- `store.sqlite` giữ hàng hóa, đơn hàng, tài khoản khách và các phiên đăng nhập. Tên/số điện thoại khách và thông tin đăng nhập acc được mã hóa bằng AES-256-GCM; mật khẩu tài khoản khách được hash bằng PBKDF2-SHA256.
- Ví điểm, biến động điểm, yêu cầu nạp, cấu hình tỷ lệ và kết quả vòng quay được lưu trong `store.sqlite`. Chỉ duyệt nạp sau khi tự kiểm tra giao dịch ngân hàng; không dựa vào ảnh chụp do khách gửi. Hệ thống không tự phát hiện khoản chuyển tiền.
- Thư mục `product-images` chứa ảnh minh họa đã tải lên; hãy sao lưu thư mục này cùng `store.sqlite` để giữ ảnh sản phẩm khi chuyển máy.
- `.env` chứa khóa mã hóa, hash mật khẩu quản trị và thông tin ngân hàng; được loại khỏi Git. Giữ riêng tư và **sao lưu cùng với `store.sqlite`**. Nếu mất khóa hoặc đổi khóa, không thể giải mã acc cũ. Không đưa `.env` lên Git, chat hoặc dịch vụ chia sẻ công khai. Mật khẩu quản trị được hash một chiều với PBKDF2-SHA256.
- Mật khẩu quản trị chỉ được đặt khi khởi tạo; giữ nó an toàn. `.\Start-Store.ps1 -ResetConfig` đặt mật khẩu quản trị và khóa mã hóa mới; khóa mới làm dữ liệu acc cũ không thể giải mã.
- Nếu không đăng nhập được, đặt lại riêng tên/mật khẩu quản trị bằng `.\Reset-AdminLogin.ps1`. Script không đổi khóa mã hóa, cấu hình ngân hàng hoặc `store.sqlite`; mật khẩu mới được nhập ẩn trực tiếp trong PowerShell. Sau đó dừng máy chủ cũ bằng `Ctrl+C`, chạy lại `.\Start-Store.ps1` và đăng nhập bằng cặp mới.
- Máy chủ giới hạn yêu cầu, bảo vệ form bằng CSRF, lưu session quản trị phía máy chủ và chỉ phục vụ các trang trong danh sách cho phép.

## Đưa website lên Internet

`localhost` chỉ truy cập được trên máy đang chạy ứng dụng. Muốn bán hàng công khai cần máy chủ/hosting chạy Node.js 22.13+, ổ đĩa bền vững cho `store.sqlite`, domain và HTTPS. Trên máy chủ đặt biến `NODE_ENV=production` để bật cookie Secure; đặt `TRUST_PROXY=1` chỉ khi ứng dụng nằm sau reverse proxy đáng tin cậy. Dùng HTTPS cho toàn bộ trang, giới hạn quyền truy cập `.env`/file sao lưu và lập lịch sao lưu cả `.env` cùng database.

Mã QR được tạo qua VietQR theo mã ngân hàng, số tài khoản và tên nhận tiền đã cấu hình. Website **không tự dò giao dịch, không tự xác nhận thanh toán và không tự hoàn tiền**. Cần xác nhận thủ công trong trang quản trị.
