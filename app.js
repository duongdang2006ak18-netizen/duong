"use strict";

const $ = (selector) => document.querySelector(selector);
const formatter = new Intl.NumberFormat("vi-VN");
const cart = new Set();
const state = { products: [], filter: "all", store: null, customer: null, customerPendingAction: "", wheel: null, wheelRotation: 0, lastOrder: null, toastTimer: null };
const statusLabels = { pending: "CHỜ XÁC NHẬN", paid: "ĐÃ THANH TOÁN", cancelled: "ĐÃ HỦY", expired: "HẾT HẠN" };
const palette = ["#a9d94d", "#e8ba62", "#65bbda", "#bc8de2", "#70b8d5", "#e38465", "#9dc461", "#d3a65f"];

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function formatPrice(price) {
  return `${formatter.format(price)} ₫`;
}

function colorFor(id) {
  return palette[Math.abs(Number(id) || 0) % palette.length];
}

async function api(url, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = getCookie("csrf");
  }
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Không thể kết nối máy chủ.");
  return data;
}

function getCookie(name) {
  const prefix = `${name}=`;
  const cookie = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : "";
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

function makeArtwork(product, index, label = "OVR") {
  const color = colorFor(product.id);
  return `<div class="product-art" style="--art-glow:${color};--art-top:${color}">
    <span class="art-index">FC / ${String(index + 1).padStart(2, "0")}</span>
    <span class="art-number">${product.ovr}</span>
    <div class="art-emblem"><span>${label}</span><strong>${product.ovr}</strong></div>
    <span class="product-badge">FC MOBILE VN</span>
  </div>`;
}

function matchingProducts() {
  const query = $("#search-input").value.trim().toLocaleLowerCase("vi");
  return state.products.filter((product) => {
    const matchesFilter = state.filter === "all"
      || (state.filter === "110" && product.ovr >= 110)
      || (state.filter === "105" && product.ovr >= 105)
      || (state.filter === "budget" && product.price <= 350000);
    const searchText = `${product.name} ${product.ovr} ${product.description}`.toLocaleLowerCase("vi");
    return matchesFilter && searchText.includes(query);
  }).sort((a, b) => {
    if ($("#sort-select").value === "price-asc") return a.price - b.price;
    if ($("#sort-select").value === "price-desc") return b.price - a.price;
    if ($("#sort-select").value === "ovr-desc") return b.ovr - a.ovr;
    return b.id - a.id;
  });
}

function renderProducts() {
  const visible = matchingProducts();
  $("#product-grid").innerHTML = visible.map((product, index) => `
    <article class="product-card">
      <button class="product-art-button" type="button" data-detail="${product.id}" aria-label="Xem chi tiết ${escapeHTML(product.name)}">
        ${product.imagePath
          ? `<div class="product-photo-wrap"><img class="product-photo" src="${escapeHTML(product.imagePath)}" alt="Ảnh minh họa ${escapeHTML(product.name)}" loading="lazy" decoding="async">${product.images.length > 1 ? `<span class="product-gallery-count">${product.images.length} ẢNH</span>` : ""}</div>`
          : makeArtwork(product, index)}
      </button>
      <div class="product-info">
        <div class="product-meta"><span>FC MOBILE · OVR ${product.ovr}</span><span class="stock"><i class="stock-dot"></i> CÒN HÀNG</span></div>
        <h3>${escapeHTML(product.name)}</h3>
        <p class="product-summary">${escapeHTML(product.description || "Tài khoản FC Mobile VN.")}</p>
        <div class="product-footer">
          <div class="product-price"><small>GIÁ BÁN</small><strong>${formatPrice(product.price)}</strong></div>
          <div class="product-actions">
            <button class="icon-button" type="button" data-detail="${product.id}" aria-label="Xem chi tiết ${escapeHTML(product.name)}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></svg>
            </button>
            <button class="add-button" type="button" data-add="${product.id}">${cart.has(product.id) ? "ĐÃ CHỌN" : "CHỌN +"}</button>
          </div>
        </div>
      </div>
    </article>`).join("");
  $("#results-note").innerHTML = `ĐANG HIỂN THỊ <strong>${String(visible.length).padStart(2, "0")}</strong> / ${String(state.products.length).padStart(2, "0")} TÀI KHOẢN`;
  const emptyState = $("#empty-state");
  const emptyReset = $("#reset-filters");
  if (state.products.length === 0) {
    emptyState.querySelector("h3").textContent = "Kho hàng đang được cập nhật";
    emptyState.querySelector("p").textContent = "Chưa có tài khoản đang bán. Bạn có thể quay lại sau hoặc liên hệ cửa hàng.";
    emptyReset.hidden = true;
  } else {
    emptyState.querySelector("h3").textContent = "Chưa tìm thấy đội hình phù hợp";
    emptyState.querySelector("p").textContent = "Thử từ khóa khác hoặc chọn một bộ lọc khác nhé.";
    emptyReset.hidden = false;
  }
  emptyState.hidden = visible.length > 0;
  $("#product-grid").hidden = visible.length === 0;
  $("#hero-stock-count").textContent = String(state.products.length).padStart(2, "0");
  const count = document.querySelector('[data-filter="all"]');
  count.innerHTML = `TẤT CẢ <span>${String(state.products.length).padStart(2, "0")}</span>`;
  updateCart();
}

function updateCart() {
  const selected = state.products.filter((product) => cart.has(product.id));
  $("#cart-count").textContent = String(selected.length);
  $("#cart-items").innerHTML = selected.map((product) => `
    <article class="cart-item">
      <div class="cart-thumb" style="--art-glow:${colorFor(product.id)}">${product.imagePath
        ? `<img src="${escapeHTML(product.imagePath)}" alt="" loading="lazy" decoding="async">`
        : product.ovr}</div>
      <div><h3>${escapeHTML(product.name)}</h3><p>OVR ${product.ovr} · FC MOBILE</p></div>
      <strong>${formatPrice(product.price)}</strong>
      <button class="remove-item" type="button" data-remove="${product.id}">XÓA</button>
    </article>`).join("");
  $("#cart-empty").hidden = selected.length > 0;
  $("#cart-bottom").hidden = selected.length === 0;
  $("#cart-total").textContent = formatPrice(selected.reduce((sum, product) => sum + product.price, 0));
}

function showDetail(id) {
  const product = state.products.find((item) => item.id === id);
  if (!product) return;
  product.detailImageIndex = 0;
  renderDetailImage(product);
  $("#detail-dialog").showModal();
}

function renderDetailImage(product) {
  const images = product.images || [];
  const imageIndex = product.detailImageIndex || 0;
  const imagePath = images[imageIndex] || product.imagePath;
  $("#detail-content").innerHTML = `
    <div class="detail-gallery">
      <div class="detail-art" style="--art-glow:${colorFor(product.id)};--art-top:${colorFor(product.id)}">
      ${imagePath
        ? `<img class="detail-photo" src="${escapeHTML(imagePath)}" alt="Ảnh minh họa ${escapeHTML(product.name)} · ${imageIndex + 1}">`
        : `<span class="art-number">${product.ovr}</span><div class="art-emblem"><span>FC</span><strong>${product.ovr}</strong></div>`}
      ${images.length > 1 ? `
        <button class="gallery-arrow gallery-previous" type="button" data-gallery-step="-1" data-product-id="${product.id}" aria-label="Xem ảnh trước">‹</button>
        <button class="gallery-arrow gallery-next" type="button" data-gallery-step="1" data-product-id="${product.id}" aria-label="Xem ảnh tiếp theo">›</button>
        <span class="gallery-position">${imageIndex + 1} / ${images.length}</span>` : ""}
      </div>
      ${images.length > 1 ? `<div class="detail-thumbnails">${images.map((image, index) => `
        <button class="detail-thumbnail${index === imageIndex ? " active" : ""}" type="button" data-gallery-index="${index}" data-product-id="${product.id}" aria-label="Xem ảnh ${index + 1}">
          <img src="${escapeHTML(image)}" alt="" loading="lazy" decoding="async">
        </button>`).join("")}</div>` : ""}
    </div>
    <div class="detail-meta">FC MOBILE VN · OVR ${product.ovr}</div>
    <h2 id="detail-title">${escapeHTML(product.name)}</h2>
    <p class="detail-description">${escapeHTML(product.description || "Tài khoản FC Mobile VN.")}</p>
    <div class="detail-list"><span>OVR TÀI KHOẢN<strong>${product.ovr}</strong></span><span>TÌNH TRẠNG<strong>CÒN HÀNG</strong></span></div>
    <button class="button button-primary detail-buy" type="button" data-add="${product.id}"><span>${cart.has(product.id) ? "ĐÃ CÓ TRONG GIỎ" : "THÊM VÀO GIỎ"}</span><strong>${formatPrice(product.price)}</strong></button>`;
}

function statusPill(status) {
  return `<span class="status-pill ${status === "paid" ? "paid" : ["cancelled", "expired"].includes(status) ? status : ""}">${statusLabels[status] || "KHÔNG RÕ"}</span>`;
}

function renderLookupResult(order) {
  const items = order.items.map((item) => `
    <div class="order-result-item">
      <h4>${escapeHTML(item.name)} · OVR ${item.ovr}</h4>
      ${order.status === "paid"
        ? `<p>Tên đăng nhập: <span class="secret-value">${escapeHTML(item.username)}</span></p><p>Mật khẩu: <span class="secret-value">${escapeHTML(item.password)}</span></p>`
        : "<p>Thông tin tài khoản sẽ hiện ở đây sau khi cửa hàng xác nhận thanh toán.</p>"}
    </div>`).join("");
  const waiting = order.status === "pending" ? '<p class="pending-message">Vui lòng chuyển khoản đúng số tiền và nội dung. Quản trị viên xác nhận thủ công.</p>' : "";
  $("#lookup-result").innerHTML = `<strong>${escapeHTML(order.code)}</strong> · ${statusPill(order.status)}<br>Tổng tiền: <strong>${formatPrice(order.total)}</strong>${waiting}<div class="order-result-items">${items}</div>`;
}

function renderCustomerOrders(orders) {
  const container = $("#customer-orders");
  if (orders.length === 0) {
    container.innerHTML = '<p class="customer-orders-empty">Chưa có đơn hàng nào được liên kết với tài khoản này.</p>';
    return;
  }
  container.innerHTML = orders.map((order) => {
    const items = order.items.map((item) => `
      <div class="customer-order-item">
        <h4>${escapeHTML(item.name)} · OVR ${item.ovr}</h4>
        ${item.username !== undefined
          ? `<p>Tên đăng nhập: <span class="secret-value">${escapeHTML(item.username)}</span></p><p>Mật khẩu: <span class="secret-value">${escapeHTML(item.password)}</span></p>`
          : `<p>${order.status === "pending" ? "Thông tin acc sẽ hiện sau khi cửa hàng xác nhận thanh toán." : "Thông tin đăng nhập acc chỉ hiển thị với đơn đã thanh toán."}</p>`}
      </div>`).join("");
    const createdAt = new Date(String(order.createdAt).replace(" ", "T"));
    return `<article class="customer-order">
      <div class="customer-order-heading"><strong>${escapeHTML(order.code)}</strong>${statusPill(order.status)}</div>
      <p class="customer-order-meta">${Number.isNaN(createdAt.getTime()) ? escapeHTML(order.createdAt) : escapeHTML(createdAt.toLocaleString("vi-VN"))} · ${formatPrice(order.total)}</p>
      <div class="customer-order-items">${items}</div>
    </article>`;
  }).join("");
}

async function loadCustomerOrders() {
  const data = await api("/api/customer/orders");
  renderCustomerOrders(data.orders);
}

function renderWheel() {
  if (!state.wheel) return;
  const colors = ["#c7fb55", "#e8ba62", "#65bbda", "#bc8de2", "#70b8d5", "#e38465", "#9dc461", "#d3a65f"];
  let cumulative = 0;
  const segmentSize = state.wheel.prizes.length ? 360 / state.wheel.prizes.length : 360;
  const segments = state.wheel.prizes.map((_prize, index) => {
    const start = cumulative;
    cumulative = (index + 1) * segmentSize;
    return `${colors[index % colors.length]} ${start.toFixed(2)}deg ${cumulative.toFixed(2)}deg`;
  });
  $("#wheel-disc").style.setProperty("--wheel-gradient", segments.length
    ? `conic-gradient(from -90deg, ${segments.join(", ")})`
    : "conic-gradient(from -90deg, #34382e 0deg 360deg)");
  const wheelDisc = $("#wheel-disc");
  const wheelSize = wheelDisc.getBoundingClientRect().width;
  const wheelCenterSize = wheelDisc.querySelector(".wheel-center").getBoundingClientRect().width;
  const wheelRadius = wheelSize / 2;
  const labelRadius = (wheelCenterSize / 2 + wheelRadius - 19) / 2;
  const labelRadiusPercent = labelRadius / wheelSize * 100;
  $("#wheel-disc").querySelectorAll(".wheel-ovr").forEach((label) => label.remove());
  state.wheel.prizes.forEach((prize, index) => {
    const angle = -90 + (index + 0.5) * segmentSize;
    const radians = angle * Math.PI / 180;
    const label = document.createElement("span");
    label.className = "wheel-ovr";
    label.setAttribute("aria-hidden", "true");
    label.style.left = `${50 + Math.sin(radians) * labelRadiusPercent}%`;
    label.style.top = `${50 - Math.cos(radians) * labelRadiusPercent}%`;
    label.textContent = `OVR ${prize.ovr}`;
    $("#wheel-disc").append(label);
  });
  $("#wheel-prizes").innerHTML = state.wheel.prizes.length
    ? state.wheel.prizes.map((prize) => `<article class="luck-prize">${prize.images[0] ? `<img src="${escapeHTML(prize.images[0])}" alt="" loading="lazy">` : `<span class="luck-prize-placeholder">${prize.ovr}</span>`}<div class="luck-prize-info"><strong>${escapeHTML(prize.name)} · OVR ${prize.ovr}</strong><span>${(prize.probability / 100).toLocaleString("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% · ${state.wheel.spinCost} điểm/lượt</span><p>${escapeHTML(prize.description || "Chưa có mô tả vật phẩm.")}</p></div></article>`).join("")
    : `<p class="customer-orders-empty">${state.wheel.ready ? "Quản trị viên chưa thêm giải thưởng." : "Vòng quay đang được quản trị viên cấu hình."}</p>`;
  $("#wheel-spin").disabled = !state.wheel.ready || state.wheel.prizes.length === 0;
  $("#wheel-topup").disabled = Boolean(state.store && !state.store.transferConfigured);
  $("#wheel-login-note").textContent = state.customer
    ? (state.wheel.ready ? "Mỗi lượt trúng một giải. Tỷ lệ hiển thị được tính lại khi giải đã trúng hết hàng." : "Vòng quay chưa có danh sách giải thưởng khả dụng.")
    : "Đăng nhập tài khoản để nạp điểm và quay thưởng.";
}

async function loadWheel() {
  state.wheel = await api("/api/wheel");
  renderWheel();
}

function renderWheelHistory(spins) {
  const container = $("#customer-spin-history");
  if (!spins.length) {
    container.innerHTML = '<p class="customer-orders-empty">Chưa có lượt quay nào.</p>';
    return;
  }
  container.innerHTML = spins.map((spin) => `
    <article class="customer-order-item">
      <h4>${escapeHTML(spin.name)} · OVR ${spin.ovr} · ${spin.pointsSpent} điểm</h4>
      <p>${escapeHTML(new Date(String(spin.createdAt).replace(" ", "T")).toLocaleString("vi-VN"))}</p>
      <p>Tên đăng nhập: <span class="secret-value">${escapeHTML(spin.username)}</span></p>
      <p>Mật khẩu: <span class="secret-value">${escapeHTML(spin.password)}</span></p>
    </article>`).join("");
}

function renderWallet(wallet) {
  $("#wheel-points").textContent = formatter.format(wallet.balance);
  $("#customer-wallet-balance").textContent = formatter.format(wallet.balance);
  const topups = wallet.topups.map((topup) => {
    const labels = { pending: "CHỜ DUYỆT", approved: "ĐÃ CỘNG ĐIỂM", rejected: "ĐÃ TỪ CHỐI" };
    return `<div class="wallet-history-row"><span>${escapeHTML(topup.code)} · ${formatPrice(topup.amount)}</span><strong>${labels[topup.status]}</strong></div>`;
  });
  $("#customer-wallet-history").innerHTML = topups.join("") || '<p class="customer-orders-empty">Chưa có giao dịch nạp điểm.</p>';
  renderWheelHistory(wallet.spins);
  renderWheel();
}

async function loadCustomerWallet() {
  const wallet = await api("/api/customer/wallet");
  renderWallet(wallet);
}

function requireCustomer(action) {
  if (state.customer) return true;
  state.customerPendingAction = action;
  $("#customer-dialog").showModal();
  $("#customer-login-error").textContent = "";
  $("#customer-register-error").textContent = "";
  showToast("Đăng nhập tài khoản để tiếp tục.");
  return false;
}

async function createWheelTopup() {
  const amount = Number($("#wheel-topup-amount").value);
  const data = await api("/api/customer/wallet/topups", { method: "POST", body: JSON.stringify({ amount }) });
  $("#topup-details").innerHTML = `
    <p class="topup-explanation">${data.existing ? "Bạn đang có yêu cầu nạp chờ duyệt. Dùng lại mã và thông tin chuyển khoản bên dưới, không tạo khoản thanh toán trùng." : `Chuyển khoản đúng số tiền và nội dung. Quản trị viên sẽ kiểm tra giao dịch rồi cộng ${data.points} điểm vào ví.`}</p>
    <div class="order-summary">
      <p>MÃ NẠP ĐIỂM · LƯU MÃ NÀY ĐỂ ĐỐI CHIẾU</p>
      <div class="order-code-row"><code>${escapeHTML(data.code)}</code><button class="copy-button" type="button" data-copy="${escapeHTML(data.code)}">SAO CHÉP</button></div>
      <div class="payment-details">
        <div>NGÂN HÀNG<strong>${escapeHTML(data.bank.code)}</strong></div>
        <div>SỐ TÀI KHOẢN<strong>${escapeHTML(data.bank.account)}</strong></div>
        <div>CHỦ TÀI KHOẢN<strong>${escapeHTML(data.bank.name)}</strong></div>
        <div>SỐ TIỀN<strong>${formatPrice(data.amount)}</strong></div>
        <div>NỘI DUNG CHUYỂN KHOẢN<strong>${escapeHTML(data.code)}</strong></div>
        <div>ĐIỂM NHẬN SAU KHI DUYỆT<strong>${data.points} ĐIỂM</strong></div>
      </div>
      <img class="payment-qr" src="${escapeHTML(data.bank.qrUrl)}" alt="Mã QR nạp ${data.points} điểm">
    </div>`;
  $("#topup-dialog").showModal();
  await loadCustomerWallet();
}

async function spinWheel() {
  if (!requireCustomer("wheel-spin")) return;
  const button = $("#wheel-spin");
  button.disabled = true;
  $("#wheel-result").textContent = "Đang quay…";
  try {
    const result = await api("/api/customer/wheel/spin", { method: "POST", body: JSON.stringify({}) });
    let prizes = state.wheel?.prizes || [];
    let prizeIndex = prizes.findIndex((prize) => prize.id === result.prize.id);
    if (prizeIndex < 0) {
      try {
        await loadWheel();
        prizes = state.wheel?.prizes || [];
        prizeIndex = prizes.findIndex((prize) => prize.id === result.prize.id);
      } catch (refreshError) {
        console.error("Could not refresh prize wheel after a successful spin:", refreshError);
      }
    }
    if (prizeIndex >= 0) {
      const center = -90 + (prizeIndex + 0.5) * 360 / prizes.length;
      const delta = (360 - center - state.wheelRotation % 360 + 360) % 360;
      state.wheelRotation += 5 * 360 + delta;
      $("#wheel-disc").style.transform = `rotate(${state.wheelRotation}deg)`;
      await new Promise((resolve) => setTimeout(resolve, 4600));
    }
    $("#wheel-result").innerHTML = `CHÚC MỪNG! Bạn trúng <strong>${escapeHTML(result.prize.name)} · OVR ${result.prize.ovr}</strong>.<br>Tên đăng nhập: <span class="secret-value">${escapeHTML(result.prize.username)}</span><br>Mật khẩu: <span class="secret-value">${escapeHTML(result.prize.password)}</span>`;
    loadCustomerWallet().catch((error) => {
      console.error("Could not refresh customer wallet after a successful spin:", error);
      showToast("Đã quay trúng acc. Tải lại trang nếu số dư chưa được cập nhật.");
    });
    loadWheel().catch((error) => console.error("Could not refresh public prize wheel:", error));
  } catch (error) {
    $("#wheel-result").textContent = error.message;
    if (error.message.includes("hết hàng") || error.message.includes("cấu hình")) {
      try { await loadWheel(); } catch (refreshError) { console.error("Could not refresh wheel after a spin error:", refreshError); }
    }
  } finally {
    button.disabled = !state.wheel?.ready || state.wheel.prizes.length === 0;
  }
}

function renderCustomerAccount() {
  const authenticated = Boolean(state.customer);
  $("#customer-auth-panel").hidden = authenticated;
  $("#customer-account-panel").hidden = !authenticated;
  $("#customer-trigger-label").textContent = authenticated ? state.customer.username : "Tài khoản";
  $("#customer-trigger-label").title = authenticated ? `Tài khoản: ${state.customer.username}` : "";
  if (authenticated) $("#customer-username").textContent = state.customer.username;
  renderWheel();
}

async function openCustomerDialog() {
  $("#customer-dialog").showModal();
  if (!state.customer) return;
  $("#customer-orders").innerHTML = '<p class="customer-orders-empty">Đang tải lịch sử đơn hàng…</p>';
  try {
    await Promise.all([loadCustomerOrders(), loadCustomerWallet()]);
  } catch (error) {
    $("#customer-orders").textContent = error.message;
  }
}

function showOrderConfirmation(order) {
  state.lastOrder = order;
  const payment = order.bank
    ? `<div class="payment-details">
        <div>NGÂN HÀNG<strong>${escapeHTML(order.bank.code)}</strong></div>
        <div>SỐ TÀI KHOẢN<strong>${escapeHTML(order.bank.account)}</strong></div>
        <div>CHỦ TÀI KHOẢN<strong>${escapeHTML(order.bank.name)}</strong></div>
        <div>SỐ TIỀN<strong>${formatPrice(order.total)}</strong></div>
        <div>NỘI DUNG CHUYỂN KHOẢN<strong>${escapeHTML(order.code)}</strong></div>
      </div><img class="payment-qr" src="${escapeHTML(order.bank.qrUrl)}" alt="Mã QR thanh toán cho đơn ${escapeHTML(order.code)}">`
    : `<p class="pending-message">Cửa hàng chưa cấu hình tài khoản nhận chuyển khoản. Đơn hàng chưa được tạo.</p>`;
  $("#order-confirmation").innerHTML = `
    <div class="order-summary"><p>MÃ ĐƠN HÀNG · TRA CỨU BẰNG SỐ ĐIỆN THOẠI</p>
      <div class="order-code-row"><code>${escapeHTML(order.code)}</code><button class="copy-button" type="button" data-copy="${escapeHTML(order.code)}">SAO CHÉP</button></div>
      <p>Đơn được giữ đến <strong>${new Date(order.expiresAt).toLocaleString("vi-VN")}</strong>.</p>${payment}
      <p class="order-instructions">Sau khi chuyển khoản, cửa hàng sẽ xác nhận thủ công. ${state.customer ? "Đơn này đã được lưu vào lịch sử tài khoản của bạn. " : ""}Bạn có thể <strong>tra cứu đơn</strong> để xem trạng thái và thông tin tài khoản đã thanh toán.</p>
      <div class="order-links"><a href="#tra-cuu" data-close-order>ĐI ĐẾN TRA CỨU ĐƠN ↗</a><a href="#" data-close-order>ĐÓNG</a></div>
    </div>`;
  $("#order-dialog").showModal();
  if (state.customer) loadCustomerOrders().catch((error) => console.error("Could not refresh customer order history:", error));
}

document.querySelector(".filter-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter;
  document.querySelectorAll(".filter-chip").forEach((chip) => {
    const selected = chip === button;
    chip.classList.toggle("active", selected);
    chip.setAttribute("aria-pressed", String(selected));
  });
  renderProducts();
});

$("#search-input").addEventListener("input", renderProducts);
$("#sort-select").addEventListener("change", renderProducts);
$("#reset-filters").addEventListener("click", () => {
  state.filter = "all";
  $("#search-input").value = "";
  document.querySelectorAll(".filter-chip").forEach((chip) => {
    const selected = chip.dataset.filter === "all";
    chip.classList.toggle("active", selected);
    chip.setAttribute("aria-pressed", String(selected));
  });
  renderProducts();
});

document.addEventListener("click", async (event) => {
  const galleryControl = event.target.closest("[data-gallery-step], [data-gallery-index]");
  if (galleryControl) {
    const product = state.products.find((item) => item.id === Number(galleryControl.dataset.productId));
    if (product) {
      const imageCount = product.images?.length || 0;
      if (imageCount > 0) {
        product.detailImageIndex = galleryControl.hasAttribute("data-gallery-index")
          ? Number(galleryControl.dataset.galleryIndex)
          : (product.detailImageIndex + Number(galleryControl.dataset.galleryStep) + imageCount) % imageCount;
        renderDetailImage(product);
      }
    }
    return;
  }

  const detail = event.target.closest("[data-detail]");
  if (detail) {
    showDetail(Number(detail.dataset.detail));
    return;
  }

  const add = event.target.closest("[data-add]");
  if (add) {
    const id = Number(add.dataset.add);
    const product = state.products.find((item) => item.id === id);
    if (!product) return;
    if (cart.has(id)) {
      $("#cart-dialog").showModal();
      return;
    }
    cart.add(id);
    $("#detail-dialog").close();
    renderProducts();
    showToast(`${product.name} đã được thêm vào giỏ.`);
    return;
  }

  const remove = event.target.closest("[data-remove]");
  if (remove) {
    const product = state.products.find((item) => item.id === Number(remove.dataset.remove));
    cart.delete(Number(remove.dataset.remove));
    renderProducts();
    if (product) showToast(`Đã xóa ${product.name} khỏi giỏ.`);
    return;
  }

  const copy = event.target.closest("[data-copy]");
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      showToast("Đã sao chép mã đơn.");
    } catch (error) {
      console.error("Clipboard copy failed:", error);
      showToast("Không thể tự sao chép. Vui lòng chọn và sao chép mã đơn.");
    }
    return;
  }

  if (event.target.closest("[data-close-order]")) {
    event.preventDefault();
    $("#order-dialog").close();
    if (event.target.closest("a").getAttribute("href") === "#tra-cuu") $("#tra-cuu").scrollIntoView({ behavior: "smooth" });
  }
});

$("#open-cart").addEventListener("click", () => $("#cart-dialog").showModal());
$("#open-customer").addEventListener("click", openCustomerDialog);
document.querySelector(".customer-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-customer-tab]");
  if (!tab) return;
  const register = tab.dataset.customerTab === "register";
  $("#customer-login-form").hidden = register;
  $("#customer-register-form").hidden = !register;
  document.querySelectorAll(".customer-tab").forEach((button) => {
    const selected = button === tab;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
});

async function submitCustomerAuth(form, endpoint, errorSelector) {
  const button = form.querySelector('button[type="submit"]');
  const formData = new FormData(form);
  const error = $(errorSelector);
  button.disabled = true;
  error.textContent = "";
  try {
    const customer = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({ username: formData.get("username"), password: formData.get("password") })
    });
    state.customer = customer;
    form.reset();
    renderCustomerAccount();
    Promise.all([loadCustomerOrders(), loadCustomerWallet()]).catch((error) => {
      $("#customer-orders").textContent = error.message;
    });
    const pendingAction = state.customerPendingAction;
    state.customerPendingAction = "";
    if (pendingAction === "checkout") {
      $("#customer-dialog").close();
      openCheckout();
    } else if (pendingAction === "wheel-spin" || pendingAction === "wheel-topup") {
      $("#customer-dialog").close();
      if (pendingAction === "wheel-spin") spinWheel();
      else createWheelTopup().catch((error) => showToast(error.message));
    }
    showToast("Đăng nhập thành công. Đơn hàng mới sẽ được lưu vào tài khoản.");
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
}

$("#customer-login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitCustomerAuth(event.currentTarget, "/api/customer/login", "#customer-login-error");
});
$("#customer-register-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitCustomerAuth(event.currentTarget, "/api/customer/register", "#customer-register-error");
});
$("#customer-logout").addEventListener("click", async () => {
  const button = $("#customer-logout");
  button.disabled = true;
  try {
    await api("/api/customer/logout", { method: "POST", body: JSON.stringify({}) });
    state.customer = null;
    state.customerPendingAction = "";
    $("#customer-orders").replaceChildren();
    renderCustomerAccount();
    showToast("Đã đăng xuất tài khoản.");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});
$("#customer-claim-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  const error = $("#customer-claim-error");
  button.disabled = true;
  error.textContent = "";
  try {
    await api("/api/customer/orders/claim", {
      method: "POST",
      body: JSON.stringify({ code: formData.get("code"), phone: formData.get("phone") })
    });
    form.reset();
    await loadCustomerOrders();
    showToast("Đã liên kết đơn hàng vào tài khoản.");
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
  }
});
$("#wheel-spin").addEventListener("click", async () => {
  await customerSessionReady;
  spinWheel();
});
$("#wheel-topup").addEventListener("click", async () => {
  await customerSessionReady;
  if (!requireCustomer("wheel-topup")) return;
  createWheelTopup().catch((error) => showToast(error.message));
});
$("#browse-products").addEventListener("click", () => {
  $("#cart-dialog").close();
  $("#san-pham").scrollIntoView({ behavior: "smooth" });
});
function openCheckout() {
  if (!state.store?.transferConfigured) {
    showToast("Cửa hàng chưa cấu hình thông tin nhận chuyển khoản.");
    return;
  }
  const selected = state.products.filter((product) => cart.has(product.id));
  if (selected.length === 0) {
    showToast("Giỏ hàng đang trống.");
    return;
  }
  $("#checkout-total").textContent = formatPrice(selected.reduce((sum, product) => sum + product.price, 0));
  $("#checkout-error").textContent = "";
  $("#checkout-dialog").showModal();
}
$("#checkout-button").addEventListener("click", async () => {
  $("#checkout-button").disabled = true;
  try {
    await customerSessionReady;
    if (!state.customer) {
      state.customerPendingAction = "checkout";
      $("#cart-dialog").close();
      $("#customer-dialog").showModal();
      $("#customer-login-error").textContent = "";
      $("#customer-register-error").textContent = "";
      showToast("Đăng nhập hoặc tạo tài khoản để tiếp tục mua hàng.");
      return;
    }
    $("#cart-dialog").close();
    openCheckout();
  } finally {
    $("#checkout-button").disabled = false;
  }
});

$("#checkout-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const formData = new FormData(form);
  button.disabled = true;
  $("#checkout-error").textContent = "";
  try {
    const order = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        name: formData.get("name"),
        phone: formData.get("phone"),
        productIds: [...cart]
      })
    });
    cart.clear();
    renderProducts();
    $("#checkout-dialog").close();
    form.reset();
    showOrderConfirmation(order);
  } catch (error) {
    $("#checkout-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#lookup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const result = $("#lookup-result");
  result.textContent = "Đang tìm đơn hàng…";
  try {
    const code = String(formData.get("code")).trim().toUpperCase();
    const params = new URLSearchParams({ phone: String(formData.get("phone")) });
    const order = await api(`/api/orders/${encodeURIComponent(code)}?${params}`);
    renderLookupResult(order);
  } catch (error) {
    result.textContent = error.message;
  }
});

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => document.getElementById(button.dataset.close).close());
});
[$("#detail-dialog"), $("#cart-dialog"), $("#checkout-dialog"), $("#order-dialog"), $("#customer-dialog"), $("#topup-dialog")].forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
});

async function loadStore() {
  try {
    const [store, data] = await Promise.all([api("/api/store"), api("/api/products")]);
    state.store = store;
    state.products = data.products;
    renderProducts();
    renderWheel();
    if (!store.transferConfigured) showToast("Quản trị viên cần cấu hình tài khoản nhận tiền trong .env.");
  } catch (error) {
    console.error("Store initialization failed:", error);
    $("#product-grid").hidden = true;
    $("#empty-state").hidden = false;
    $("#empty-state").innerHTML = `<span aria-hidden="true">!</span><h3>Chưa kết nối được cửa hàng</h3><p>${escapeHTML(error.message)} Hãy kiểm tra máy chủ rồi tải lại trang.</p>`;
    $("#results-note").textContent = "KHÔNG THỂ TẢI DANH SÁCH TÀI KHOẢN";
  }
}

loadStore();
loadWheel().catch((error) => {
  console.error("Wheel initialization failed:", error);
  $("#wheel-prizes").textContent = error.message;
});
const customerSessionReady = api("/api/customer/session")
  .then((customer) => {
    state.customer = customer;
    renderCustomerAccount();
    renderWheel();
    loadCustomerWallet().catch((error) => console.error("Could not load customer wallet:", error));
  })
  .catch((error) => {
    if (!error.message.startsWith("Vui lòng đăng nhập") && !error.message.startsWith("Phiên đăng nhập đã hết hạn")) {
      console.error("Customer session check failed:", error);
    }
    renderCustomerAccount();
    renderWheel();
  });
