const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Target Limit: Exactly 3 images per UTC day stored in D1
const DAILY_IMAGE_LIMIT = 3;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight options
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // GET /api/gallery - Fetch combined D1 & Raindrop images
    if (path === "/api/gallery" && request.method === "GET") {
      try {
        const fetchLimit = parseInt(env.FETCH_LIMIT || "50", 10);
        
        const d1Images = await env.DB.prepare(`
          SELECT images.id, images.imgbb_url, folders.name as folder_name, images.created_at
          FROM images 
          JOIN folders ON images.folder_id = folders.id 
          ORDER BY images.id DESC
          LIMIT ?
        `).bind(fetchLimit).all();

        let results = d1Images.results || [];

        // If D1 doesn't have enough images to fill limit, fetch remaining from Raindrop
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

    // POST /api/upload - UTC Date Limit + Metadata Write Tracking
    if (path === "/api/upload" && request.method === "POST") {
      try {
        const { folderName, base64Images } = await request.json();
        
        if (!base64Images || !base64Images.length) {
          return Response.json(
            { success: false, error: "No image files provided." },
            { status: 400, headers: corsHeaders }
          );
        }

        // 1. Get today's UTC Date (resets automatically at 00:00 UTC)
        const todayUTC = new Date().toISOString().split("T")[0];

        // 2. Count images stored in D1 so far today
        const countResult = await env.DB.prepare(`
          SELECT COUNT(*) as total 
          FROM images 
          WHERE DATE(created_at) = ?
        `).bind(todayUTC).first();

        const imagesStoredToday = countResult ? parseInt(countResult.total, 10) : 0;

        // 3. Upload images to ImgBB
        let imageUrls = [];
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

        // 4. Calculate available D1 slots remaining today
        const availableSlots = Math.max(0, DAILY_IMAGE_LIMIT - imagesStoredToday);

        let d1Urls = [];
        let raindropUrls = [];

        if (availableSlots >= imageUrls.length) {
          d1Urls = imageUrls;
        } else {
          d1Urls = imageUrls.slice(0, availableSlots);
          raindropUrls = imageUrls.slice(availableSlots);
        }

        // 5. Save images to D1 & track physical row writes
        let d1WriteMeta = { rows_written: 0 };
        if (d1Urls.length > 0) {
          d1WriteMeta = await saveToD1(env, folderName, d1Urls);
        }

        // 6. Save overflow images to Raindrop
        if (raindropUrls.length > 0) {
          await saveToRaindrop(env, folderName, raindropUrls);
        }

        ctx.waitUntil(
          sendTelegramNotification(
            env, 
            `Uploaded ${imageUrls.length} image(s): ${d1Urls.length} to D1, ${raindropUrls.length} to Raindrop.`
          )
        );

        return Response.json(
          { 
            success: true, 
            d1Saved: d1Urls.length, 
            raindropSaved: raindropUrls.length,
            imagesStoredToday: imagesStoredToday + d1Urls.length,
            dailyLimit: DAILY_IMAGE_LIMIT,
            actualRowsWritten: d1WriteMeta.rows_written
          },
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

        // Delete execution returns write metadata
        const result = await env.DB.prepare("DELETE FROM images WHERE id = ?").bind(id).run();

        return Response.json(
          { 
            success: true, 
            message: `Image ${id} deleted successfully.`, 
            rowsWrittenByDelete: result.meta.rows_written 
          },
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

async function saveToD1(env, folderName, imageUrls) {
  let totalRowsWritten = 0;

  // 1. Get or create Folder
  let folder = await env.DB.prepare("SELECT id FROM folders WHERE name = ?")
    .bind(folderName)
    .first();
  
  if (!folder) {
    const folderInsert = await env.DB.prepare("INSERT INTO folders (name) VALUES (?)")
      .bind(folderName)
      .run();

    totalRowsWritten += folderInsert.meta.rows_written || 0;

    folder = await env.DB.prepare("SELECT id FROM folders WHERE name = ?")
      .bind(folderName)
      .first();
  }

  if (!folder || !folder.id) {
    throw new Error(`Could not locate or create folder: ${folderName}`);
  }

  // 2. Insert Images Batch
  const stmts = imageUrls.map(url => 
    env.DB.prepare("INSERT INTO images (folder_id, imgbb_url, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
      .bind(folder.id, url)
  );

  const batchResults = await env.DB.batch(stmts);
  
  // Accumulate total database write modifications (inserts + index updates)
  batchResults.forEach(res => {
    totalRowsWritten += res.meta.rows_written || 0;
  });

  return { rows_written: totalRowsWritten };
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
