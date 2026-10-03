// Swagger UI for the generated OpenAPI document.
const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Taskflow API</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui.min.css" />
</head>
<body>
  <div id="ui"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui-bundle.min.js"></script>
  <script>SwaggerUIBundle({ url: "/api/openapi.json", dom_id: "#ui" });</script>
</body>
</html>`;

export const GET = () => new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
