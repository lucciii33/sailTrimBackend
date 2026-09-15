async function postMessage({ botToken, channelId, text, blocks }) {
  if (!botToken) throw new Error("Slack bot token missing");
  if (!channelId) throw new Error("Slack channel id missing");
  if (!text && !blocks) throw new Error("Slack message body missing");

  const body = { channel: channelId };
  if (text) body.text = text;
  if (blocks) body.blocks = blocks;

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    const err = data?.error || `${response.status} ${response.statusText}`;
    throw new Error(`Slack postMessage failed: ${err}`);
  }
  return data;
}

module.exports = { postMessage };
