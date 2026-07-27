/**
 * Reactions, fetched in the browser.
 *
 * This runs *after* the page is served, which is the entire point. A
 * server-rendered version of this feature sits on the render path and needs a
 * cache, a timeout budget, a warming job, and a story for what to show when the
 * upstream is slow. Here the page is already on screen; if these requests never
 * return, the reader has still read the post.
 *
 * Two very different sources:
 *
 *   AppView       app.bsky.feed.getPostThread  -> one Bluesky post's counts
 *                                                 and its reply tree
 *   Backlink index  Constellation /links/count -> who links to this target,
 *                                                 in ANY app
 *
 * They overlap — Constellation also sees `app.bsky.feed.like` — so likes and
 * reposts are read from the AppView only, and Constellation supplies the
 * collections the AppView cannot know about.
 */
(function () {
  "use strict";

  var root = document.querySelector("[data-atmo-reactions]");
  if (!root) return;

  var atUri = root.getAttribute("data-at-uri") || "";
  var pageUrl = root.getAttribute("data-page-url") || "";
  var appview = root.getAttribute("data-appview") || "";
  var constellation = root.getAttribute("data-constellation") || "";

  /** Collections the AppView already counts; skip them in the index totals. */
  var APPVIEW_OWNED = ["app.bsky.feed.like", "app.bsky.feed.repost", "app.bsky.feed.post"];

  var LABELS = {
    "site.standard.graph.recommend": "recommends",
    "pub.leaflet.comment": "comments",
    "com.whtwnd.blog.comment": "comments",
    "sh.tangled.feed.star": "stars",
    "social.grain.favorite": "favourites",
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text; // text, never markup
    return node;
  }

  function getJson(url) {
    return fetch(url, { mode: "cors", credentials: "omit" }).then(function (response) {
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    });
  }

  /** The bskyPostRef this document points at, if the record carried one. */
  function companionUri() {
    return root.getAttribute("data-bsky-uri") || "";
  }

  function renderCounts(counts) {
    var list = el("ul", "reaction-counts");
    var any = false;
    Object.keys(counts).forEach(function (label) {
      if (!counts[label]) return;
      any = true;
      list.appendChild(el("li", "reaction-count", counts[label] + " " + label));
    });
    return any ? list : null;
  }

  function renderReplies(replies) {
    if (!replies.length) return null;
    var list = el("ol", "reaction-replies");
    replies.forEach(function (reply) {
      var item = el("li", "reaction-reply");
      var who = reply.author || "someone";
      item.appendChild(el("p", "reply-author", who));
      item.appendChild(el("p", "reply-text", reply.text || ""));
      if (reply.url) {
        var link = el("a", "reply-link", "in context");
        link.href = reply.url;
        link.rel = "noopener noreferrer";
        item.appendChild(link);
      }
      list.appendChild(item);
    });
    return list;
  }

  function flattenThread(node, out) {
    if (!node || typeof node !== "object") return out;
    (node.replies || []).forEach(function (child) {
      var post = child && child.post;
      if (post && post.record) {
        out.push({
          author: (post.author && (post.author.displayName || post.author.handle)) || "",
          text: typeof post.record.text === "string" ? post.record.text : "",
          url:
            post.author && post.uri
              ? "https://bsky.app/profile/" +
                post.author.did +
                "/post/" +
                post.uri.slice(post.uri.lastIndexOf("/") + 1)
              : "",
        });
      }
      flattenThread(child, out);
    });
    return out;
  }

  function loadAppView(counts) {
    var uri = companionUri();
    if (!uri || !appview) return Promise.resolve(null);
    return getJson(
      appview + "/xrpc/app.bsky.feed.getPostThread?uri=" + encodeURIComponent(uri) + "&depth=2",
    )
      .then(function (data) {
        var thread = data && data.thread;
        var post = thread && thread.post;
        if (post) {
          if (post.likeCount) counts.likes = post.likeCount;
          if (post.repostCount) counts.reposts = post.repostCount;
        }
        return flattenThread(thread, []);
      })
      .catch(function () {
        return null; // upstream down: the section simply has less in it
      });
  }

  function loadBacklinks(counts) {
    if (!constellation) return Promise.resolve();
    var targets = [atUri, pageUrl].filter(Boolean);
    return Promise.all(
      targets.map(function (target) {
        return getJson(constellation + "/links/all?target=" + encodeURIComponent(target)).catch(
          function () {
            return null;
          },
        );
      }),
    ).then(function (results) {
      results.forEach(function (data) {
        if (!data || !data.links) return;
        Object.keys(data.links).forEach(function (nsid) {
          if (APPVIEW_OWNED.indexOf(nsid) !== -1) return; // avoid double-counting
          var total = 0;
          var byPath = data.links[nsid];
          Object.keys(byPath).forEach(function (path) {
            var entry = byPath[path];
            total += typeof entry === "number" ? entry : entry && entry.count ? entry.count : 0;
          });
          if (!total) return;
          var label = LABELS[nsid] || nsid;
          counts[label] = (counts[label] || 0) + total;
        });
      });
    });
  }

  var counts = {};
  Promise.all([loadAppView(counts), loadBacklinks(counts)]).then(function (results) {
    var replies = results[0] || [];
    var countsNode = renderCounts(counts);
    var repliesNode = renderReplies(replies);

    // Nothing to show is a perfectly good outcome: leave the page alone.
    if (!countsNode && !repliesNode) return;

    root.appendChild(el("h2", "reactions-heading", "Responses"));
    if (countsNode) root.appendChild(countsNode);
    if (repliesNode) root.appendChild(repliesNode);
    root.removeAttribute("hidden");
  });
})();
