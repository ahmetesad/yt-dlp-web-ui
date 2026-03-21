import http from "node:http";
import https from "node:https";
import net from "node:net";
import { AppError } from "./errors.js";
import { resolvePublicOrigin } from "./network.js";

function stripHopByHopHeaders(headers) {
  const nextHeaders = { ...headers };

  delete nextHeaders["connection"];
  delete nextHeaders["proxy-authorization"];
  delete nextHeaders["proxy-authenticate"];
  delete nextHeaders["proxy-connection"];
  delete nextHeaders["te"];
  delete nextHeaders["trailer"];
  delete nextHeaders["transfer-encoding"];
  delete nextHeaders["upgrade"];

  return nextHeaders;
}

function parseConnectAuthority(authority) {
  if (typeof authority !== "string" || !authority) {
    throw new AppError("Invalid CONNECT target.", 400);
  }

  if (authority.startsWith("[")) {
    const closingBracketIndex = authority.indexOf("]");
    const hostname = authority.slice(1, closingBracketIndex);
    const port = authority.slice(closingBracketIndex + 2);

    if (closingBracketIndex === -1 || !port) {
      throw new AppError("Invalid CONNECT target.", 400);
    }

    return { hostname, port };
  }

  const separatorIndex = authority.lastIndexOf(":");

  if (separatorIndex === -1) {
    throw new AppError("Invalid CONNECT target.", 400);
  }

  return {
    hostname: authority.slice(0, separatorIndex),
    port: authority.slice(separatorIndex + 1)
  };
}

function writeProxyError(responseLike, statusCode, message) {
  if ("writeHead" in responseLike) {
    responseLike.writeHead(statusCode, {
      "Content-Type": "text/plain; charset=utf-8",
      Connection: "close"
    });
    responseLike.end(message);
    return;
  }

  responseLike.end(
    [
      `HTTP/1.1 ${statusCode} ${message}`,
      "Connection: close",
      "Content-Type: text/plain; charset=utf-8",
      "",
      message
    ].join("\r\n")
  );
}

async function handleProxyRequest(request, response) {
  let targetUrl;

  try {
    targetUrl = new URL(request.url || "");
  } catch {
    writeProxyError(response, 400, "Invalid proxy request.");
    return;
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    writeProxyError(response, 400, "Unsupported proxy protocol.");
    return;
  }

  let origin;

  try {
    origin = await resolvePublicOrigin(
      targetUrl.hostname,
      targetUrl.port,
      targetUrl.protocol
    );
  } catch (error) {
    writeProxyError(response, 403, error.message);
    return;
  }

  const transport = targetUrl.protocol === "https:" ? https : http;
  const headers = stripHopByHopHeaders(request.headers);
  headers.host = targetUrl.host;
  const requestOptions = {
    headers,
    host: origin.address,
    method: request.method,
    path: `${targetUrl.pathname}${targetUrl.search}`,
    port: origin.port,
    setHost: false
  };

  if (targetUrl.protocol === "https:") {
    requestOptions.servername = origin.hostname;
  }

  const upstreamRequest = transport.request(requestOptions, (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode || 502,
        upstreamResponse.headers
      );
      upstreamResponse.pipe(response);
    });

  upstreamRequest.on("error", () => {
    if (!response.headersSent) {
      writeProxyError(response, 502, "Proxy request failed.");
      return;
    }

    response.destroy();
  });

  request.pipe(upstreamRequest);
}

async function handleConnectRequest(request, clientSocket, head) {
  let target;

  try {
    target = parseConnectAuthority(request.url || "");
  } catch (error) {
    writeProxyError(clientSocket, 400, error.message);
    return;
  }

  let origin;

  try {
    origin = await resolvePublicOrigin(target.hostname, target.port, "https:");
  } catch (error) {
    writeProxyError(clientSocket, 403, error.message);
    return;
  }

  const upstreamSocket = net.connect({
    host: origin.address,
    port: origin.port
  });

  upstreamSocket.on("connect", () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    if (head && head.length > 0) {
      upstreamSocket.write(head);
    }

    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  });

  upstreamSocket.on("error", () => {
    if (!clientSocket.destroyed) {
      writeProxyError(clientSocket, 502, "Proxy tunnel failed.");
    }
  });

  clientSocket.on("error", () => {
    upstreamSocket.destroy();
  });
}

export async function createSafeProxyServer() {
  const server = http.createServer((request, response) => {
    handleProxyRequest(request, response).catch(() => {
      writeProxyError(response, 500, "Proxy request failed.");
    });
  });

  server.on("connect", (request, socket, head) => {
    handleConnectRequest(request, socket, head).catch(() => {
      writeProxyError(socket, 500, "Proxy tunnel failed.");
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Proxy server did not expose a TCP port.");
  }

  return {
    close() {
      server.close();
    },
    port: address.port,
    url: `http://127.0.0.1:${address.port}`
  };
}
