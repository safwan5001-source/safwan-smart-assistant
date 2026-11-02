(function () {
    var $ = function (id) { return document.getElementById(id); };
    var showEcho = function () { $("echo").textContent = $("fullname").value + (($("notes").value) ? " / " + $("notes").value : ""); };
    $("fullname").addEventListener("input", showEcho);
    $("notes").addEventListener("input", showEcho);
    $("inc").addEventListener("click", function () { $("count").textContent = String(Number($("count").textContent) + 1); });
    // The demo form never leaves the page: the "submission" is local text only.
    $("demo-form").addEventListener("submit", function (e) { e.preventDefault(); $("result").textContent = "تم الإرسال محلياً: " + $("term").value; });
  })();
