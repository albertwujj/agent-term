async function imageAsPng(image) {
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d').drawImage(image, 0, 0);
  const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!png) throw new Error('Could not encode image for the clipboard');
  return png;
}

function copyImageToClipboard(image) {
  // Start the write during the user's click, while the PNG is being encoded.
  return navigator.clipboard.write([new window.ClipboardItem({
    'image/png': imageAsPng(image),
  })]);
}

module.exports = { copyImageToClipboard };
