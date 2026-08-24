// Standard CORS headers allowing unrestricted access from any website/client
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Handle CORS preflight requests (OPTIONS method)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    await checkAndResetCounter(env);

    // 2. GET /api/gallery - Fetch images from D1 with Raindrop fallback
    if (path === "/api/gallery" && request.method === "GET") {
      try {
        const fetchLimit = parseInt(env.FETCH_LIMIT || "50", 10);
        
        const d1Images = await env.DB.prepare(`
          SELECT images.id, images.imgbb_url, folders.name as folder_name 
          FROM images 
          JOIN folders ON images.folder_id = folders.id 
          ORDER BY images.id DESC
          LIMIT ?
        `).bind(fetchLimit).all();

        let results = d1Images.results || [];

        if (results.length < fetchLimit) {
          const remainingCapacity = fetchLimit - results.length;
          const raindropItems = await fetchRaindropImages(env, remainingCapacity);
          results = results.concat(raindropItems);
        }

        return Response.json(
          { success: true, count: results.length, data: results },
          { headers: corsHeaders }
        );
      } catch (error) {
        return Response.json(
          { success: false, error: error.message },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // 3. POST /api/upload - Upload batch images with fallback logic
    if (path === "/api/upload" && request.method === "POST") {
      try {
        const { folderName, imageUrls } = await request.json();
        const requestLimit = parseInt(env.REQUEST_LIMIT || "95000", 10);
        const currentUsage = await incrementUsageCounter(env, imageUrls.length);

        let storageUsed = "Cloudflare D1";

        if (currentUsage > requestLimit) {
          await saveToRaindrop(env, folderName, imageUrls);
          storageUsed = "Raindrop.io (Fallback)";
        } else {
          await saveToD1(env, folderName, imageUrls);
          ctx.waitUntil(syncRaindropToD1(env));
        }

        ctx.waitUntil(
          sendTelegramNotification(
            env, 
            `Uploaded ${imageUrls.length} image(s) to folder "${folderName}" via ${storageUsed}.`
          )
        );

        return Response.json(
          { success: true, storageUsed, totalUsageToday: currentUsage },
          { headers: corsHeaders }
        );
      } catch (error) {
        return Response.json(
          { success: false, error: error.message },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    return new Response("Endpoint Not Found", { status: 404, headers: corsHeaders });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncRaindropToD1(env));
  }
};

/* --- Helpers --- */

async function incrementUsageCounter(env, count) {
  await env.DB.prepare(`
    UPDATE system_stats 
    SET value = value + ? 
    WHERE key = 'daily_requests'
  `).bind(count).run();

  const row = await env.DB.prepare(
    "SELECT value FROM system_stats WHERE key = 'daily_requests'"
  ).first();

  return row ? row.value : 0;
}

async function checkAndResetCounter(env) {
  const row = await env.DB.prepare(
    "SELECT last_reset FROM system_stats WHERE key = 'daily_requests'"
  ).first();

  const today = new Date().toISOString().split("T")[0];
  if (row && row.last_reset !== today) {
    await env.DB.prepare(`
      UPDATE system_stats 
      SET value = 0, last_reset = ? 
      WHERE key = 'daily_requests'
    `).bind(today).run();
  }
}

async function saveToD1(env, folderName, imageUrls) {
  let folder = await env.DB.prepare("SELECT id FROM folders WHERE name = ?").bind(folderName).first();
  
  if (!folder) {
    const res = await env.DB.prepare("INSERT INTO folders (name) VALUES (?)").bind(folderName).run();
    folder = { id: res.meta.last_row_id };
  }

  const stmts = imageUrls.map(url => 
    env.DB.prepare("INSERT INTO images (folder_id, imgbb_url) VALUES (?, ?)").bind(folder.id, url)
  );

  await env.DB.batch(stmts);
}

async function saveToRaindrop(env, folderName, imageUrls) {
  for (const url of imageUrls) {
    await fetch("https://api.raindrop.io/rest/v1/raindrop", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RAINDROP_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        link: url,
        title: folderName,
        tags: [folderName, "pending_sync"]
      })
    });
  }
}

async function fetchRaindropImages(env, limit) {
  if (!env.RAINDROP_API_KEY) return [];

  const res = await fetch(`https://api.raindrop.io/rest/v1/raindrops/0?perpage=${limit}`, {
    headers: { "Authorization": `Bearer ${env.RAINDROP_API_KEY}` }
  });
  
  if (!res.ok) return [];
  const data = await res.json();

  return (data.items || []).map(item => ({
    id: item._id,
    imgbb_url: item.link,
    folder_name: item.title || "Raindrop Fallback"
  }));
}

async function syncRaindropToD1(env) {
  const pendingItems = await fetchRaindropImages(env, 50);
  if (!pendingItems.length) return;

  for (const item of pendingItems) {
    await saveToD1(env, item.folder_name, [item.imgbb_url]);
  }
}

async function sendTelegramNotification(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: message
    })
  });
}
