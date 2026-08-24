const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    await checkAndResetCounter(env);

    // GET /api/gallery - Fetch combined D1 & Raindrop images
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

    // POST /api/upload - Upload base64 images via ImgBB secret & store in D1
    if (path === "/api/upload" && request.method === "POST") {
      try {
        const { folderName, base64Images } = await request.json();
        
        if (!base64Images || !base64Images.length) {
          return Response.json(
            { success: false, error: "No image files provided." },
            { status: 400, headers: corsHeaders }
          );
        }

        const requestLimit = parseInt(env.REQUEST_LIMIT || "95000", 10);
        const currentUsage = await incrementUsageCounter(env, base64Images.length);

        let imageUrls = [];

        // Upload images to ImgBB via worker secret key
        for (const base64Data of base64Images) {
          const formData = new FormData();
          formData.append("image", base64Data);

          const imgbbRes = await fetch(`https://api.imgbb.com/1/upload?key=${env.IMGBB_API_KEY}`, {
            method: "POST",
            body: formData
          });

          const imgbbJson = await imgbbRes.json();
          if (imgbbJson.success) {
            imageUrls.push(imgbbJson.data.url);
          } else {
            throw new Error(`ImgBB Error: ${imgbbJson.error ? imgbbJson.error.message : 'Upload failed'}`);
          }
        }

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

    // DELETE /api/gallery/:id - Delete an image by ID from D1
    if (path.startsWith("/api/gallery/") && request.method === "DELETE") {
      try {
        const id = path.split("/").pop();
        
        if (!id || isNaN(id)) {
          return Response.json(
            { success: false, error: "Invalid Image ID" },
            { status: 400, headers: corsHeaders }
          );
        }

        const result = await env.DB.prepare("DELETE FROM images WHERE id = ?").bind(id).run();

        return Response.json(
          { success: true, message: `Image ${id} deleted successfully.`, meta: result.meta },
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

// Fixed D1 storage logic
async function saveToD1(env, folderName, imageUrls) {
  let folder = await env.DB.prepare("SELECT id FROM folders WHERE name = ?")
    .bind(folderName)
    .first();
  
  if (!folder) {
    await env.DB.prepare("INSERT INTO folders (name) VALUES (?)")
      .bind(folderName)
      .run();

    folder = await env.DB.prepare("SELECT id FROM folders WHERE name = ?")
      .bind(folderName)
      .first();
  }

  if (!folder || !folder.id) {
    throw new Error(`Could not locate or create folder: ${folderName}`);
  }

  const stmts = imageUrls.map(url => 
    env.DB.prepare("INSERT INTO images (folder_id, imgbb_url) VALUES (?, ?)")
      .bind(folder.id, url)
  );

  await env.DB.batch(stmts);
}

async function saveToRaindrop(env, folderName, imageUrls) {
  if (!env.RAINDROP_API_KEY) return;

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
