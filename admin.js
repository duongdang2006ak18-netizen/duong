"use strict";

const $ = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat("vi-VN");
const stateNames = { pending: "CHỜ XÁC NHẬN", paid: "ĐÃ THANH TOÁN", cancelled: "ĐÃ HỦY", expired: "HẾT HẠN" };
const inventoryNames = { available: "CÒN HÀNG", reserved: "ĐANG GIỮ ĐƠN", sold: "ĐÃ BÁN", archived: "ĐÃ ẨN" };

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function cookieValue(name) {
  const prefix = `${name}=`;
  const cookie = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : "";
}

async function api(url, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  const method = (options.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers["X-CSRF-Token"] = cookieValue("csrf");
  }
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Không thể kết nối máy chủ.");
  return data;
}

function message(text, kind = "") {
  const element = $("#admin-message");
  element.textContent = text;
  element.className = `admin-banner${kind ? ` ${kind}` : ""}`;
}

function formatPrice(value) {
  return `${money.format(value)} ₫`;
}

function statusMarkup(status) {
  const style = status === "paid" ? "paid" : ["cancelled", "expired"].includes(status) ? status : "";
  return `<span class="status-pill ${style}">${stateNames[status] || escapeHTML(status)}</span>`;
}

async function loadOrders() {
  const data = await api("/api/admin/orders");
  const body = $("#orders-body");
  $("#orders-empty").hidden = data.orders.length > 0;
  body.innerHTML = data.orders.map((order) => `
    <tr>
      <td><strong>${escapeHTML(order.code)}</strong><div class="order-products">${new Date(order.createdAt).toLocaleString("vi-VN")}</div></td>
      <td><strong>${escapeHTML(order.customerName)}</strong><div class="order-products">${escapeHTML(order.phone)}</div></td>
      <td>${order.items.map((item) => `<div>${escapeHTML(item.name)} · OVR ${item.ovr}</div>`).join("")}<strong>${formatPrice(order.total)}</strong></td>
      <td>${statusMarkup(order.status)}${order.status === "pending" ? `<div class="order-products">Hạn: ${new Date(order.expiresAt).toLocaleString("vi-VN")}</div>` : ""}</td>
      <td><div class="admin-actions">${order.status === "pending" ? `<button class="button button-primary" type="button" data-confirm="${escapeHTML(order.code)}">ĐÃ NHẬN TIỀN</button><button class="button danger-button" type="button" data-cancel="${escapeHTML(order.code)}">HỦY ĐƠN</button>` : "—"}</div></td>
    </tr>`).join("");
}

async function loadProducts() {
  const data = await api("/api/admin/products");
  $("#products-empty").hidden = data.products.length > 0;
  $("#products-body").innerHTML = data.products.map((product) => `
    <tr><td><strong>${escapeHTML(product.name)}</strong><div class="order-products">OVR ${product.ovr}</div></td>
    <td><div class="inventory-images">${product.images.map((image) => `
        <div class="inventory-image"><img src="${escapeHTML(image.imagePath)}" alt="Ảnh ${escapeHTML(product.name)}">
          <button class="inventory-image-remove" type="button" data-remove-image="${image.id}" data-product-id="${product.id}" aria-label="Xóa ảnh của ${escapeHTML(product.name)}">×</button></div>`).join("") || "<span class=\"order-products\">Chưa có ảnh</span>"}</div>
      <span class="order-products">${product.images.length}/5 ảnh</span>
      <label class="button button-secondary inventory-image-upload">${product.images.length ? "THÊM ẢNH" : "TẢI ẢNH"}<input class="visually-hidden" type="file" data-product-images="${product.id}" accept="image/jpeg,image/png,image/webp" multiple aria-label="Chọn ảnh cho ${escapeHTML(product.name)}" ${product.images.length >= 5 ? "disabled" : ""}></label></td>
    <td>${formatPrice(product.price)}</td><td>${inventoryNames[product.status] || escapeHTML(product.status)}</td>
    <td>${new Date(product.created_at).toLocaleString("vi-VN")}</td>
    <td>${product.status === "available" ? `<button class="button danger-button" type="button" data-archive="${product.id}">ẨN ACC</button>` : "—"}</td></tr>`).join("");
}

async function loadTopups() {
  const data = await api("/api/admin/wheel/topups");
  const labels = { pending: "CHỜ DUYỆT", approved: "ĐÃ CỘNG ĐIỂM", rejected: "ĐÃ TỪ CHỐI" };
  $("#topups-empty").hidden = data.topups.length > 0;
  $("#topups-body").innerHTML = data.topups.map((topup) => `
    <tr>
      <td><strong>${escapeHTML(topup.code)}</strong><div class="order-products">${new Date(topup.createdAt).toLocaleString("vi-VN")}</div></td>
      <td>${escapeHTML(topup.username)}</td>
      <td><strong>${formatPrice(topup.amount)}</strong><div class="order-products">${topup.points} điểm</div></td>
      <td>${labels[topup.status] || escapeHTML(topup.status)}</td>
      <td><div class="admin-actions">${topup.status === "pending"
        ? `<button class="button button-primary" type="button" data-topup-approve="${topup.id}">ĐÃ NHẬN TIỀN</button><button class="button danger-button" type="button" data-topup-reject="${topup.id}">TỪ CHỐI</button>`
        : "—"}</div></td>
    </tr>`).join("");
}

async function loadWheelPrizes() {
  const data = await api("/api/admin/wheel/prizes");
  const configured = new Map(data.prizes.map((prize) => [prize.id, prize]));
  const body = $("#wheel-prizes-body");
  $("#wheel-prizes-empty").hidden = data.products.length > 0;
  body.innerHTML = data.products.map((product) => {
    const prize = configured.get(product.id);
    return `<tr data-wheel-row="${product.id}">
      <td><input class="wheel-prize-check" type="checkbox" data-wheel-check="${product.id}" aria-label="Chọn ${escapeHTML(product.name)} làm giải" ${prize ? "checked" : ""}></td>
      <td><strong>${escapeHTML(product.name)}</strong><div class="order-products">OVR ${product.ovr}</div></td>
      <td><input class="wheel-prize-probability" type="number" min="0.01" max="100" step="0.01" value="${prize ? (prize.probability / 100).toFixed(2) : ""}" data-wheel-probability="${product.id}" aria-label="Tỷ lệ trúng ${escapeHTML(product.name)}" ${prize ? "" : "disabled"}></td>
      <td>${prize ? "ĐANG CÀI" : ""}</td>
    </tr>`;
  }).join("");
  if (data.prizes.some((prize) => prize.status !== "available")) {
    message("Một số giải đã hết hàng; vòng quay tự chuẩn hóa tỷ lệ theo các giải còn hàng. Có thể chọn lại và lưu pool mới.", "error");
  }
  updateWheelProbabilityTotal();
}

function updateWheelProbabilityTotal() {
  const total = [...document.querySelectorAll("[data-wheel-check]:checked")]
    .reduce((sum, checkbox) => sum + (Number(document.querySelector(`[data-wheel-probability="${checkbox.dataset.wheelCheck}"]`).value) || 0), 0);
  $("#wheel-probability-total").textContent = `Tổng tỷ lệ: ${total.toLocaleString("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

async function refreshDashboard() {
  await Promise.all([loadOrders(), loadProducts(), loadTopups(), loadWheelPrizes()]);
}

function showDashboard() {
  $("#login-panel").hidden = true;
  $("#dashboard").hidden = false;
  $("#logout-button").hidden = false;
}

function showLogin() {
  $("#login-panel").hidden = false;
  $("#dashboard").hidden = true;
  $("#logout-button").hidden = true;
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const values = new FormData(form);
  button.disabled = true;
  message("");
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username: values.get("username"), password: values.get("password") })
    });
    form.reset();
    showDashboard();
    await refreshDashboard();
    message("Đăng nhập quản trị thành công.", "success");
  } catch (error) {
    message(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#product-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const values = new FormData(form);
  button.disabled = true;
  message("");
  try {
    await api("/api/admin/products", {
      method: "POST",
      body: values
    });
    form.reset();
    await loadProducts();
    await loadWheelPrizes();
    await loadOrders();
    message("Đã thêm tài khoản vào kho.", "success");
  } catch (error) {
    message(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#products-body").addEventListener("change", async (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.matches("[data-product-images]") || !input.files?.length) return;
  const files = [...input.files];
  const productId = input.dataset.productImages;
  if (files.length > 5) {
    message("Mỗi lần chỉ có thể chọn tối đa 5 ảnh.", "error");
    input.value = "";
    return;
  }

  const formData = new FormData();
  files.forEach((file) => formData.append("images", file));
  input.disabled = true;
  message("");
  try {
    await api(`/api/admin/products/${encodeURIComponent(productId)}/images`, {
      method: "POST",
      body: formData
    });
    await loadProducts();
    message(`Đã thêm ${files.length} ảnh minh họa sản phẩm.`, "success");
  } catch (error) {
    message(error.message, "error");
  } finally {
    input.disabled = false;
    input.value = "";
  }
});

$("#products-body").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-image]");
  if (!button) return;
  if (!window.confirm("Xóa ảnh minh họa này khỏi sản phẩm?")) return;
  button.disabled = true;
  message("");
  try {
    await api(`/api/admin/products/${encodeURIComponent(button.dataset.productId)}/images/${encodeURIComponent(button.dataset.removeImage)}`, {
      method: "DELETE"
    });
    await loadProducts();
    message("Đã xóa ảnh minh họa.", "success");
  } catch (error) {
    message(error.message, "error");
    button.disabled = false;
  }
});

$("#wheel-prizes-body").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-wheel-check]");
  if (checkbox) {
    const input = document.querySelector(`[data-wheel-probability="${checkbox.dataset.wheelCheck}"]`);
    input.disabled = !checkbox.checked;
    if (checkbox.checked && !input.value) input.value = "0.01";
  }
  updateWheelProbabilityTotal();
});

$("#save-wheel-prizes").addEventListener("click", async () => {
  const prizes = [...document.querySelectorAll("[data-wheel-check]:checked")].map((checkbox) => ({
    productId: Number(checkbox.dataset.wheelCheck),
    probability: Number(document.querySelector(`[data-wheel-probability="${checkbox.dataset.wheelCheck}"]`).value)
  }));
  const button = $("#save-wheel-prizes");
  button.disabled = true;
  message("");
  try {
    await api("/api/admin/wheel/prizes", { method: "PUT", body: JSON.stringify({ prizes }) });
    await loadWheelPrizes();
    message("Đã lưu danh sách giải và tỷ lệ quay.", "success");
  } catch (error) {
    message(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

async function reviewTopup(id, action) {
  const approved = action === "approve";
  if (!window.confirm(approved
    ? "Đã kiểm tra ngân hàng và nhận đủ tiền theo đúng mã nạp? Thao tác này sẽ cộng điểm vào ví khách."
    : "Từ chối yêu cầu nạp điểm này? Khách cần tạo yêu cầu mới sau khi bị từ chối.")) return;
  try {
    await api(`/api/admin/wheel/topups/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ action }) });
    await loadTopups();
    message(approved ? "Đã duyệt và cộng điểm vào ví khách." : "Đã từ chối yêu cầu nạp điểm.", "success");
  } catch (error) {
    message(error.message, "error");
  }
}

async function changeOrder(code, action) {
  const confirmed = action === "confirm"
    ? window.confirm(`Đã kiểm tra tài khoản ngân hàng và nhận đủ tiền cho đơn ${code}? Thao tác này sẽ đánh dấu tài khoản là đã bán.`)
    : window.confirm(`Hủy đơn ${code} và trả tài khoản về kho?`);
  if (!confirmed) return;
  message("");
  try {
    await api(`/api/admin/orders/${encodeURIComponent(code)}`, { method: "PATCH", body: JSON.stringify({ action }) });
    await refreshDashboard();
    message(action === "confirm" ? `Đã xác nhận thanh toán đơn ${code}.` : `Đã hủy đơn ${code}.`, "success");
  } catch (error) {
    message(error.message, "error");
  }
}

document.addEventListener("click", (event) => {
  const archiveButton = event.target.closest("[data-archive]");
  if (archiveButton) {
    const accepted = window.confirm("Ẩn tài khoản này khỏi cửa hàng? Thao tác không xóa đơn hàng cũ.");
    if (accepted) {
      api(`/api/admin/products/${encodeURIComponent(archiveButton.dataset.archive)}`, { method: "DELETE" })
        .then(async () => {
          await refreshDashboard();
          message("Đã ẩn tài khoản khỏi cửa hàng.", "success");
        })
        .catch((error) => message(error.message, "error"));
    }
    return;
  }
  const confirmButton = event.target.closest("[data-confirm]");
  if (confirmButton) {
    changeOrder(confirmButton.dataset.confirm, "confirm");
    return;
  }
  const cancelButton = event.target.closest("[data-cancel]");
  if (cancelButton) {
    changeOrder(cancelButton.dataset.cancel, "cancel");
    return;
  }
  const topupApproveButton = event.target.closest("[data-topup-approve]");
  if (topupApproveButton) {
    reviewTopup(topupApproveButton.dataset.topupApprove, "approve");
    return;
  }
  const topupRejectButton = event.target.closest("[data-topup-reject]");
  if (topupRejectButton) reviewTopup(topupRejectButton.dataset.topupReject, "reject");
});

$("#refresh-orders").addEventListener("click", () => refreshDashboard().catch((error) => message(error.message, "error")));
$("#refresh-products").addEventListener("click", () => loadProducts().catch((error) => message(error.message, "error")));
$("#refresh-topups").addEventListener("click", () => loadTopups().catch((error) => message(error.message, "error")));
$("#refresh-wheel-prizes").addEventListener("click", () => loadWheelPrizes().catch((error) => message(error.message, "error")));
$("#logout-button").addEventListener("click", async () => {
  try {
    await api("/api/admin/logout", { method: "POST", body: "{}" });
    showLogin();
    message("Đã đăng xuất.");
  } catch (error) {
    message(error.message, "error");
  }
});

async function initialize() {
  try {
    await api("/api/store");
    await api("/api/admin/session");
    showDashboard();
    await refreshDashboard();
  } catch (error) {
    if (error.message.includes("đăng nhập") || error.message.includes("hết hạn")) {
      showLogin();
      return;
    }
    showLogin();
    message(error.message, "error");
  }
}

initialize();
