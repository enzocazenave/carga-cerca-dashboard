'use strict';

// Set de íconos lineales compartido por toda la plataforma (mapa, vista
// cliente, panel admin), para no depender de emojis (rendering distinto
// entre SO/navegador, sin control de color/tamaño). Trazos en viewBox
// 24x24, pensados para heredar fill/stroke del contenedor.
const CC_ICONS = {
  // Sólido: es el mismo rayo de /public/icons/icon-*.png (la marca).
  bolt: '<path d="M13 2L4.5 13.5H11L10 22L19.5 9.5H13L13 2Z" fill="currentColor" stroke="none"/>',
  plug: '<path d="M9 2v5M15 2v5"/><path d="M6.5 7h11a1 1 0 0 1 1 1v3a6.5 6.5 0 0 1-13 0V8a1 1 0 0 1 1-1Z"/><path d="M12 17.5V22"/>',
  batteryLow: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M21 10v4"/><rect x="5" y="10.5" width="3" height="3" fill="currentColor" stroke="none"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  arrowRightCircle: '<circle cx="12" cy="12" r="9"/><path d="M9 8l4 4-4 4"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  alertTriangle: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>',
  car: '<path d="M5 11l1.3-4a2 2 0 0 1 1.9-1.4h7.6a2 2 0 0 1 1.9 1.4L19 11"/><rect x="3" y="11" width="18" height="6" rx="2"/><circle cx="7.5" cy="17.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="16.5" cy="17.5" r="1.3" fill="currentColor" stroke="none"/>',
  mapPin: '<path d="M12 21s7-7.2 7-12a7 7 0 1 0-14 0c0 4.8 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/>',
};

// Ícono como <svg> independiente (botones, badges, etc). `color` fija
// stroke Y el atributo `color` (para que los sub-paths con
// fill="currentColor" —el rayo, los puntitos— tomen el mismo tono).
function iconSvg(name, opts) {
  opts = opts || {};
  var size = opts.size || 20;
  var color = opts.color || 'currentColor';
  var strokeWidth = opts.strokeWidth || 2;
  var inner = CC_ICONS[name] || '';
  return (
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" ' +
    'fill="none" stroke="' + color + '" color="' + color + '" ' +
    'stroke-width="' + strokeWidth + '" stroke-linecap="round" stroke-linejoin="round">' +
    inner +
    '</svg>'
  );
}
