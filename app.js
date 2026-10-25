import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut, updateProfile } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, collection, query, where, onSnapshot, addDoc, serverTimestamp, orderBy, getDocs, limit, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = id => document.getElementById(id);
const authView = $("authView"), welcomeView = $("welcomeView"), chatView = $("chatView");
let auth, db, storage, currentUser = null, isSignup = false, activeChatId = null;
let stopChats = null, stopMessages = null, stopPresence = null, chatCache = [], toastTimer, presenceTimer, selectedCustomerUid = null, customerMetaCache = {};
let walletRequestType = "withdraw", walletDemoTransactions = [];

const configReady = firebaseConfig.apiKey !== "PASTE_API_KEY_HERE" &&
  firebaseConfig.projectId !== "PASTE_PROJECT_ID_HERE";

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}
function initials(value="") { return (value.trim()[0] || "ع").toUpperCase(); }
function formatBytes(bytes=0) {
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1048576) return `${(bytes/1024).toFixed(0)} ك.ب`;
  return `${(bytes/1048576).toFixed(1)} م.ب`;
}
function safeText(value="") { return String(value); }
function showScreen(screen) {
  welcomeView.hidden = screen !== "welcome";
  authView.hidden = screen !== "auth";
  chatView.hidden = screen !== "chat";
  $("customerView").hidden = screen !== "customers";
  $("walletView").hidden = screen !== "wallet";
}
function openAuth(signup=false) {
  isSignup = signup; $("authTitle").textContent = signup ? "إنشاء حساب جديد" : "تسجيل الدخول";
  if (signup && !$("nameInput").value.trim()) $("nameInput").value = "Mohamed Reda";
  $("authSubtitle").textContent = signup ? "أنشئ حسابك لتبدأ التواصل مع العملاء." : "ادخل لحسابك لمتابعة محادثات العملاء.";
  $("authSubmit").textContent = signup ? "إنشاء الحساب" : "دخول";
  $("nameField").hidden = !signup;
  $("switchAuth").textContent = signup ? "لديك حساب بالفعل؟ سجّل الدخول" : "ليس لديك حساب؟ أنشئ حسابًا";
  $("passwordInput").autocomplete = signup ? "new-password" : "current-password";
  $("authError").textContent = ""; showScreen("auth");
}
function formatTime(ts) {
  if (!ts) return "";
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  return date.toLocaleTimeString("ar-EG",{hour:"2-digit",minute:"2-digit"});
}
function toDate(ts) { return ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : null); }
function isOnline(profile) {
  const last = toDate(profile?.lastSeenAt);
  return profile?.online === true && !!last && Date.now() - last.getTime() < 120000;
}
function lastSeenLabel(profile) {
  if (isOnline(profile)) return "متصل الآن";
  const date = toDate(profile?.lastSeenAt);
  if (!date) return "غير متصل";
  const mins = Math.max(1, Math.floor((Date.now()-date.getTime())/60000));
  if (mins < 60) return `آخر ظهور منذ ${mins} دقيقة`;
  if (mins < 1440) return `آخر ظهور منذ ${Math.floor(mins/60)} ساعة`;
  return `آخر ظهور ${date.toLocaleDateString("ar-EG")}`;
}
async function updatePresence(online) {
  if (!currentUser || !db) return;
  try {
    await setDoc(doc(db,"users",currentUser.uid), {
      uid:currentUser.uid, email:currentUser.email,
      name:currentUser.displayName || currentUser.email,
      online, lastSeenAt:serverTimestamp()
    },{merge:true});
  } catch (e) { console.warn("Presence update failed",e); }
}
function startPresence() {
  clearInterval(presenceTimer);
  updatePresence(true);
  presenceTimer = setInterval(() => {
    if (document.visibilityState === "visible") updatePresence(true);
    else updatePresence(false);
  }, 60000);
  document.addEventListener("visibilitychange", visibilityHandler);
  window.addEventListener("beforeunload", unloadPresence);
}
function visibilityHandler() { updatePresence(document.visibilityState === "visible"); }
function unloadPresence() {
  if (!currentUser || !db) return;
  // Best-effort update; browser shutdown may prevent this from reaching Firebase.
  setDoc(doc(db,"users",currentUser.uid),{online:false,lastSeenAt:serverTimestamp()},{merge:true}).catch(()=>{});
}
function sortChats(chats) {
  return chats.sort((a,b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0));
}
function renderChats() {
  const search = $("searchInput").value.trim().toLowerCase();
  const filtered = chatCache.filter(c => `${c.otherName} ${c.otherEmail}`.toLowerCase().includes(search));
  $("chatCount").textContent = String(chatCache.length);
  const list = $("chatList"); list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("div"); empty.className = "empty-list";
    empty.textContent = currentUser ? (search ? "لا توجد نتائج مطابقة." : "لا توجد محادثات بعد. اضغط «محادثة جديدة».") : "سجّل الدخول لعرض محادثاتك.";
    list.append(empty); return;
  }
  filtered.forEach(c => {
    const button = document.createElement("button"); button.className = "chat-item" + (c.id === activeChatId ? " active" : "");
    const avatar = document.createElement("span"); avatar.className = "avatar" + (isOnline(c.otherProfile) ? " is-online" : ""); avatar.textContent = initials(c.otherName || c.otherEmail);
    const meta = document.createElement("span"); meta.className = "contact-meta";
    const line = document.createElement("span"); line.className = "contact-line";
    const name = document.createElement("strong"); name.textContent = c.otherName || c.otherEmail;
    const time = document.createElement("time"); time.textContent = formatTime(c.updatedAt);
    const last = document.createElement("span"); last.className = "last-message"; last.textContent = c.lastMessage || c.otherEmail;
    line.append(name,time); meta.append(line,last); button.append(avatar,meta);
    button.addEventListener("click", () => openChat(c.id));
    list.append(button);
  });
}
function stopListeners() {
  if (stopChats) stopChats(); if (stopMessages) stopMessages();
  stopChats = null; stopMessages = null;
}
function listenForChats() {
  if (!currentUser) return;
  if (stopChats) stopChats();
  if (stopPresence) stopPresence();
  stopPresence = onSnapshot(collection(db,"users"), snap => {
    const profiles = new Map(snap.docs.map(d => [d.id,d.data()]));
    chatCache = chatCache.map(c => {
      const profile = profiles.get(c.otherUid) || c.otherProfile || {};
      return {...c, otherProfile:profile, otherName:profile.name || profile.email || c.otherName};
    });
    if (activeChatId) {
      const c = chatCache.find(x => x.id === activeChatId);
      if (c) $("activeEmail").textContent = c.otherEmail + " · " + lastSeenLabel(c.otherProfile);
    }
    renderChats();
  }, err => console.warn("Presence listener error",err));
  const q = query(collection(db,"chats"), where("members","array-contains",currentUser.uid));
  stopChats = onSnapshot(q, async snap => {
    const items = [];
    for (const d of snap.docs) {
      const data = d.data();
      const otherUid = (data.members || []).find(uid => uid !== currentUser.uid);
      const other = (data.memberProfiles || {})[otherUid] || {};
      items.push({id:d.id, ...data, otherUid, otherProfile:other, otherName:other.name || other.email || "عميل", otherEmail:other.email || ""});
    }
    chatCache = sortChats(items); renderChats(); if (!$("customerView").hidden) renderCustomerRows();
    if (activeChatId && !chatCache.some(c => c.id === activeChatId)) {
      activeChatId = null; showScreen("welcome");
    }
  }, err => toast("تعذر تحميل المحادثات: " + err.message));
}
async function openChat(chatId) {
  const chat = chatCache.find(c => c.id === chatId);
  if (!chat) return;
  activeChatId = chatId; renderChats();
  $("activeName").textContent = chat.otherName;
  $("activeEmail").textContent = chat.otherEmail + " · " + lastSeenLabel(chat.otherProfile);
  $("activeAvatar").textContent = initials(chat.otherName || chat.otherEmail);
  showScreen("chat"); $("sidebar").classList.remove("open");
  if (stopMessages) stopMessages();
  const q = query(collection(db,"chats",chatId,"messages"), orderBy("createdAt","asc"), limit(300));
  stopMessages = onSnapshot(q, snap => {
    const wrap = $("messages"); wrap.replaceChildren();
    if (snap.empty) {
      const p = document.createElement("div"); p.className = "messages-placeholder"; p.textContent = "ابدأ المحادثة بإرسال أول رسالة."; wrap.append(p); return;
    }
    snap.forEach(messageDoc => {
      const m = messageDoc.data(), bubble = document.createElement("div");
      bubble.className = "message " + (m.senderId === currentUser.uid ? "mine" : "theirs");
      if (m.fileUrl) {
        const attachment = document.createElement("div"); attachment.className = "message-attachment";
        if ((m.fileType || "").startsWith("image/")) {
          const img = document.createElement("img"); img.src = m.fileUrl; img.alt = m.fileName || "صورة مرفقة";
          img.loading = "lazy"; img.addEventListener("click", () => window.open(m.fileUrl,"_blank","noopener"));
          attachment.append(img);
        }
        const link = document.createElement("a"); link.className = "file-link"; link.href = m.fileUrl;
        link.target = "_blank"; link.rel = "noopener noreferrer"; link.download = m.fileName || "";
        const icon = document.createElement("span"); icon.textContent = (m.fileType || "").startsWith("image/") ? "🖼️" : "📎";
        const label = document.createElement("span"); label.textContent = `${m.fileName || "ملف مرفق"}${m.fileSize ? " · " + formatBytes(m.fileSize) : ""}`;
        link.append(icon,label); attachment.append(link); bubble.append(attachment);
      }
      if (m.text) { const content = document.createElement("div"); content.textContent = safeText(m.text); bubble.append(content); }
      const meta = document.createElement("div"); meta.className = "message-meta";
      const time = document.createElement("span"); time.textContent = formatTime(m.createdAt);
      meta.append(time); bubble.append(meta); wrap.append(bubble);
    });
    wrap.scrollTop = wrap.scrollHeight;
  }, err => toast("تعذر تحميل الرسائل: " + err.message));
}
const customerStatusLabels = {new:"عميل جديد",contacted:"تم التواصل",in_progress:"قيد العمل",completed:"تم الإنجاز",paused:"متوقف مؤقتًا"};
function customerStatusClass(status) { return ({new:"customer-new",contacted:"customer-contacted",in_progress:"customer-progress",completed:"customer-completed",paused:"customer-paused"})[status] || "customer-new"; }
function renderCustomerRows() {
  const q = ($("customerSearch").value || "").trim().toLowerCase();
  const rows = chatCache.filter(c => `${c.otherName} ${c.otherEmail}`.toLowerCase().includes(q));
  $("customerTotal").textContent = `${rows.length} عميل`;
  const tbody = $("customerRows"); tbody.replaceChildren();
  if (!rows.length) { const tr=document.createElement("tr"), td=document.createElement("td"); td.colSpan=4; td.className="customer-empty-row"; td.textContent=currentUser?(q?"لا توجد نتائج مطابقة.":"لا توجد جهات اتصال بعد. ابدأ محادثة مع عميل."):"سجّل الدخول لعرض العملاء."; tr.append(td); tbody.append(tr); return; }
  rows.forEach(c => {
    const tr=document.createElement("tr"); if(c.otherUid===selectedCustomerUid) tr.className="selected";
    const person=document.createElement("td"), wrap=document.createElement("div"); wrap.className="customer-person";
    const avatar=document.createElement("span"); avatar.className="avatar"+(isOnline(c.otherProfile)?" is-online":""); avatar.textContent=initials(c.otherName||c.otherEmail);
    const info=document.createElement("span"), name=document.createElement("strong"), email=document.createElement("small"); name.textContent=c.otherName||"عميل"; email.textContent=c.otherEmail; info.append(name,email); wrap.append(avatar,info); person.append(wrap);
    const statusCell=document.createElement("td"), status=document.createElement("span"), meta=customerMetaCache[c.otherUid]||{}; status.className="customer-status "+customerStatusClass(meta.status||"new"); status.textContent=customerStatusLabels[meta.status||"new"]; statusCell.append(status);
    const seen=document.createElement("td"); seen.className="customer-seen"; seen.textContent=lastSeenLabel(c.otherProfile);
    const action=document.createElement("td"), btn=document.createElement("button"); btn.type="button"; btn.className="view-customer-btn"; btn.textContent="إدارة"; btn.addEventListener("click",()=>selectCustomer(c.otherUid)); action.append(btn);
    tr.append(person,statusCell,seen,action); tr.addEventListener("click",e=>{if(!e.target.closest("button"))selectCustomer(c.otherUid)}); tbody.append(tr);
  });
}
async function selectCustomer(uid) {
  const c=chatCache.find(x=>x.otherUid===uid); if(!c)return;
  selectedCustomerUid=uid; const meta=customerMetaCache[uid]||{};
  $("customerEditorEmpty").hidden=true; $("customerEditorFields").hidden=false;
  $("customerUid").value=uid; $("customerName").textContent=c.otherName||"عميل"; $("customerEmail").textContent=c.otherEmail;
  $("customerAvatar").textContent=initials(c.otherName||c.otherEmail); $("customerStatus").value=meta.status||"new"; $("customerNotes").value=meta.notes||"";
  renderCustomerRows();
}
async function openCustomers() {
  if(!currentUser){openAuth(false);return;}
  showScreen("customers"); $("sidebar").classList.remove("open");
  try {
    const refs=await Promise.all(chatCache.map(async c=>{
      if(!c.otherUid || customerMetaCache[c.otherUid])return;
      try { const snap=await getDoc(doc(db,"users",currentUser.uid,"customers",c.otherUid)); if(snap.exists())customerMetaCache[c.otherUid]=snap.data(); }
      catch(err){console.warn("Customer metadata read failed",err);}
    }));
    renderCustomerRows();
    if(selectedCustomerUid && chatCache.some(c=>c.otherUid===selectedCustomerUid)) selectCustomer(selectedCustomerUid);
  } catch(err){toast("تعذر تحميل بيانات العملاء.");console.error(err);}
}
$("manageCustomersBtn").addEventListener("click",openCustomers);
$("openWalletBtn").addEventListener("click", () => {
  showScreen("wallet");
  $("sidebar").classList.remove("open");
});
function setWalletRequestType(type) {
  walletRequestType = type;
  const withdrawing = type === "withdraw";
  $("withdrawTab").classList.toggle("active", withdrawing);
  $("depositTab").classList.toggle("active", !withdrawing);
  $("walletRequestSubmit").textContent = withdrawing ? "إنشاء طلب سحب تجريبي" : "تسجيل إيداع تجريبي";
  $("walletRequestNote").textContent = withdrawing
    ? `سيتم إنشاء طلب سحب تجريبي بقيمة ${Number($("walletAmount").value || 0).toLocaleString("ar-EG")} جنيه إلى الرقم المدخل، ولن يتم إرسال أموال فعلية.`
    : `سيتم تسجيل إيداع تجريبي بقيمة ${Number($("walletAmount").value || 0).toLocaleString("ar-EG")} جنيه، ولن يتم استلام أموال فعلية.`;
}
$("withdrawTab").addEventListener("click", () => setWalletRequestType("withdraw"));
$("depositTab").addEventListener("click", () => setWalletRequestType("deposit"));
$("walletAmount").addEventListener("input", () => setWalletRequestType(walletRequestType));
$("walletRequestForm").addEventListener("submit", e => {
  e.preventDefault();
  const amount = Number($("walletAmount").value);
  const phone = $("walletPhone").value.trim();
  if (!Number.isFinite(amount) || amount < 1 || amount > 100000) { toast("اكتب مبلغًا صحيحًا بين 1 و100000 جنيه."); return; }
  if (!/^01[0125][0-9]{8}$/.test(phone)) { toast("اكتب رقم محفظة مصريًا صحيحًا مكوّنًا من 11 رقمًا."); return; }
  const id = `WAS-DEMO-${Date.now().toString().slice(-8)}`;
  const item = {type:walletRequestType, amount, phone, id, time:new Date()};
  walletDemoTransactions.unshift(item);
  const row = document.createElement("article"); row.className = "withdrawal-transaction";
  const symbol = document.createElement("div"); symbol.className = "transaction-symbol"; symbol.textContent = walletRequestType === "withdraw" ? "↗" : "↙";
  const details = document.createElement("div"); details.className = "transaction-details";
  const title = document.createElement("strong"); title.textContent = walletRequestType === "withdraw" ? "طلب سحب تجريبي إلى فودافون كاش" : "إيداع تجريبي عبر فودافون كاش";
  const ref = document.createElement("span"); ref.textContent = `رقم الطلب: ${id}`;
  const target = document.createElement("span"); target.textContent = `الرقم: ${phone} · ${item.time.toLocaleString("ar-EG")}`;
  details.append(title,ref,target);
  const amountWrap = document.createElement("div"); amountWrap.className = "transaction-amount";
  const amountText = document.createElement("strong"); amountText.textContent = `${walletRequestType === "withdraw" ? "−" : "+"} ${amount.toLocaleString("en-US",{minimumFractionDigits:2})} ج.م`;
  const status = document.createElement("span"); status.className = "transaction-status pending"; status.textContent = "طلب تجريبي · لم يتم التحويل";
  amountWrap.append(amountText,status); row.append(symbol,details,amountWrap);
  $("walletTransactionList").prepend(row);
  $("transactionCount").textContent = `${walletDemoTransactions.length + 1} عملية تجريبية`;
  $("walletRequestResult").hidden = false;
  $("walletRequestResult").textContent = `تم إنشاء طلب تجريبي ${id} فقط. لم يتم سحب أو إيداع أي أموال، والموقع غير متصل بفودافون كاش.`;
  toast("تم تسجيل الطلب التجريبي داخل الصفحة فقط.");
});
$("copyTransactionBtn").addEventListener("click", async () => {
  const transactionId = "WAS-DEMO-1500";
  try {
    await navigator.clipboard.writeText(transactionId);
    toast("تم نسخ رقم العملية التجريبية.");
  } catch {
    const helper = document.createElement("textarea"); helper.value = transactionId; document.body.append(helper); helper.select();
    const copied = document.execCommand("copy"); helper.remove();
    toast(copied ? "تم نسخ رقم العملية التجريبية." : "رقم العملية: " + transactionId);
  }
});
$("customerSearch").addEventListener("input",renderCustomerRows);
$("customerEditor").addEventListener("submit",async e=>{
  e.preventDefault(); if(!currentUser||!selectedCustomerUid)return;
  const button=e.submitter; if(button)button.disabled=true;
  const data={uid:selectedCustomerUid,status:$("customerStatus").value,notes:$("customerNotes").value.trim(),updatedAt:serverTimestamp()};
  try { await setDoc(doc(db,"users",currentUser.uid,"customers",selectedCustomerUid),data,{merge:true}); customerMetaCache[selectedCustomerUid]={...data,updatedAt:new Date()}; renderCustomerRows(); toast("تم حفظ بيانات العميل."); }
  catch(err){console.error(err);toast("لم يتم الحفظ. راجع قواعد Firestore.");}
  finally{if(button)button.disabled=false;}
});
$("openCustomerChat").addEventListener("click",()=>{const c=chatCache.find(x=>x.otherUid===selectedCustomerUid);if(c)openChat(c.id);});
$("customerStartChat").addEventListener("click",()=>$("newChatBtn").click());

$("authForm").addEventListener("submit", async e => {
  e.preventDefault(); if (!auth) return;
  const email = $("emailInput").value.trim().toLowerCase(), password = $("passwordInput").value;
  const name = $("nameInput").value.trim();
  $("authError").textContent = "";
  $("authSubmit").disabled = true;
  try {
    if (isSignup) {
      if (!name) throw new Error("اكتب اسمك أولًا.");
      const result = await createUserWithEmailAndPassword(auth,email,password);
      await updateProfile(result.user,{displayName:name});
      await setDoc(doc(db,"users",result.user.uid),{uid:result.user.uid,name,email,createdAt:serverTimestamp()});
      toast("تم إنشاء الحساب بنجاح.");
    } else {
      await signInWithEmailAndPassword(auth,email,password); toast("أهلًا بك من جديد.");
    }
  } catch(err) {
    const messages = {
      "auth/email-already-in-use":"هذا البريد مسجل بالفعل.",
      "auth/invalid-email":"البريد الإلكتروني غير صحيح.",
      "auth/weak-password":"كلمة المرور ضعيفة. استخدم 6 أحرف على الأقل.",
      "auth/invalid-credential":"البريد أو كلمة المرور غير صحيحة.",
      "auth/network-request-failed":"تحقق من اتصال الإنترنت."
    };
    $("authError").textContent = messages[err.code] || err.message || "حدث خطأ. حاول مرة أخرى.";
  } finally { $("authSubmit").disabled = false; }
});
$("switchAuth").addEventListener("click", () => openAuth(!isSignup));
$("welcomeLogin").addEventListener("click", () => openAuth(false));
$("welcomeSignup").addEventListener("click", () => openAuth(true));
$("profileBtn").addEventListener("click", () => currentUser ? toast("أنت مسجل الدخول بالفعل.") : openAuth(false));
$("openChatsBtn").addEventListener("click", () => {
  if (!currentUser) { openAuth(true); return; }
  if (chatCache.length) openChat(chatCache[0].id);
  else { $("newChatBtn").click(); }
});
$("authBack").addEventListener("click", () => showScreen("welcome"));
$("logoutBtn").addEventListener("click", async () => { await signOut(auth); toast("تم تسجيل الخروج."); });
$("searchInput").addEventListener("input", renderChats);
$("newChatBtn").addEventListener("click", () => {
  if (!currentUser) { openAuth(false); return; }
  $("newChatError").textContent = ""; $("clientEmail").value = ""; $("newChatDialog").showModal();
});
$("closeDialog").addEventListener("click", () => $("newChatDialog").close());
$("newChatForm").addEventListener("submit", async e => {
  e.preventDefault(); if (!currentUser) return;
  const email = $("clientEmail").value.trim().toLowerCase();
  $("newChatError").textContent = "";
  if (email === currentUser.email.toLowerCase()) { $("newChatError").textContent = "اكتب بريد عميل آخر، وليس بريدك."; return; }
  const submit = e.submitter; if (submit) submit.disabled = true;
  try {
    const users = await getDocs(query(collection(db,"users"),where("email","==",email),limit(1)));
    if (users.empty) { $("newChatError").textContent = "لم نعثر على حساب بهذا البريد. يجب أن ينشئ العميل حسابًا أولًا."; return; }
    const otherDoc = users.docs[0], other = otherDoc.data();
    const members = [currentUser.uid, other.uid].sort();
    const chatId = members.join("_");
    const chatRef = doc(db,"chats",chatId);
    const existing = await getDoc(chatRef);
    if (!existing.exists()) {
      const myProfile = {name:currentUser.displayName || currentUser.email,email:currentUser.email};
      const otherProfile = {name:other.name || other.email,email:other.email};
      await setDoc(chatRef,{members,memberProfiles:{[currentUser.uid]:myProfile,[other.uid]:otherProfile},lastMessage:"بدأت محادثة جديدة",updatedAt:serverTimestamp(),createdAt:serverTimestamp()});
    }
    $("newChatDialog").close();
    const found = chatCache.find(c => c.id === chatId);
    if (found) openChat(chatId);
    else setTimeout(() => { const c=chatCache.find(x=>x.id===chatId); if(c) openChat(chatId); },500);
  } catch(err) { $("newChatError").textContent = "تعذر فتح المحادثة. راجع إعدادات Firebase وقواعد Firestore."; console.error(err); }
  finally { if (submit) submit.disabled = false; }
});
$("messageForm").addEventListener("submit", async e => {
  e.preventDefault(); const text = $("messageInput").value.trim();
  if (!text || !currentUser || !activeChatId) return;
  const input = $("messageInput"); input.value = ""; input.focus();
  try {
    await addDoc(collection(db,"chats",activeChatId,"messages"),{text,senderId:currentUser.uid,senderEmail:currentUser.email,createdAt:serverTimestamp()});
    await setDoc(doc(db,"chats",activeChatId),{lastMessage:text,updatedAt:serverTimestamp()},{merge:true});
  } catch(err) { input.value = text; toast("لم تُرسل الرسالة. تحقق من اتصالك وإعدادات Firebase."); console.error(err); }
});
$("attachBtn").addEventListener("click", () => {
  if (!currentUser || !activeChatId) { toast("افتح محادثة أولًا."); return; }
  $("fileInput").click();
});
$("fileInput").addEventListener("change", async e => {
  const file = e.target.files?.[0]; if (!file) return;
  const allowed = /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|application\/vnd\.ms-excel|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|text\/plain|text\/csv|application\/zip|application\/x-zip-compressed)$/i;
  if (!(file.type.startsWith("image/") || allowed.test(file.type)) || file.size > 10*1024*1024) {
    toast("نوع الملف غير مدعوم أو حجمه أكبر من 10 ميجابايت."); e.target.value = ""; return;
  }
  const chatId = activeChatId;
  $("uploadNote").hidden = false; $("uploadNote").textContent = "جارٍ رفع الملف...";
  $("attachBtn").disabled = true;
  try {
    const path = `chats/${chatId}/${currentUser.uid}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g,"_")}`;
    const fileRef = storageRef(storage,path);
    await uploadBytes(fileRef,file,{contentType:file.type || "application/octet-stream"});
    const url = await getDownloadURL(fileRef);
    await addDoc(collection(db,"chats",chatId,"messages"),{
      text:"",senderId:currentUser.uid,senderEmail:currentUser.email,
      fileUrl:url,filePath:path,fileName:file.name,fileType:file.type,fileSize:file.size,
      createdAt:serverTimestamp()
    });
    await setDoc(doc(db,"chats",chatId),{lastMessage:(file.type.startsWith("image/")?"📷 صورة":"📎 "+file.name),updatedAt:serverTimestamp()},{merge:true});
    $("uploadNote").textContent = "تم إرسال الملف.";
  } catch(err) {
    console.error(err); $("uploadNote").textContent = "تعذر رفع الملف. تحقق من تفعيل Firebase Storage وقواعده.";
    toast("فشل رفع الملف.");
  } finally { $("attachBtn").disabled = false; e.target.value = ""; setTimeout(()=>{$("uploadNote").hidden=true;},3500); }
});
$("openSidebar").addEventListener("click", () => $("sidebar").classList.add("open"));
$("closeSidebar").addEventListener("click", () => $("sidebar").classList.remove("open"));
$("backToChats").addEventListener("click", () => { showScreen("welcome"); $("sidebar").classList.add("open"); });

if (!configReady) {
  $("connectionStatus").textContent = "يلزم إعداد Firebase";
  $("accountStatus").textContent = "أكمل إعداد الموقع";
  $("myName").textContent = "حسابك";
  showScreen("welcome");
  toast("الموقع جاهز للتصميم؛ فعّل Firebase لتشغيل الرسائل الحقيقية.");
} else {
  const app = initializeApp(firebaseConfig); auth = getAuth(app); db = getFirestore(app); storage = getStorage(app);
  onAuthStateChanged(auth, async user => {
    stopListeners(); currentUser = user; activeChatId = null; chatCache = []; customerMetaCache = {}; selectedCustomerUid = null;
    if (user) {
      let profile = null;
      try { const p = await getDoc(doc(db,"users",user.uid)); if(p.exists()) profile = p.data(); } catch {}
      const name = user.displayName || profile?.name || user.email;
      $("myName").textContent = name; $("topName").textContent = name;
      $("myAvatar").textContent = $("topAvatar").textContent = initials(name);
      $("accountStatus").textContent = user.email; $("logoutBtn").hidden = false;
      $("connectionStatus").textContent = "متصل";
      listenForChats(); startPresence(); showScreen("welcome");
    } else {
      clearInterval(presenceTimer);
      document.removeEventListener("visibilitychange", visibilityHandler);
      window.removeEventListener("beforeunload", unloadPresence);
      $("myName").textContent = "حسابك"; $("topName").textContent = "دخول / إنشاء حساب";
      $("accountStatus").textContent = "غير مسجل الدخول"; $("logoutBtn").hidden = true;
      $("connectionStatus").textContent = "غير متصل"; showScreen("welcome");
    }
  });
}
