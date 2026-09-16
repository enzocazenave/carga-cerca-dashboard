#include <Wire.h>
#include <SPI.h>

#include <Adafruit_INA219.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

#include <PN532_HSU.h>
#include <PN532.h>

#include <XPT2046_Touchscreen.h>

#include <WiFi.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h> // guarda el WiFi y el número de cargador en flash (NVS), sobrevive apagones
#include <ctype.h>

// Fuentes vectoriales: vienen incluidas con Adafruit-GFX-Library
// (carpeta Fonts/), no hace falta instalar ninguna librería nueva.
// Las usamos en la marca, los títulos y los números grandes, que
// con la fuente clásica a tamaño 2-4 se veían "pixeladas".
#include <Fonts/FreeSansBold9pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold18pt7b.h>

#define FONT_BRAND &FreeSansBold9pt7b   // "CargaCerca" en el header
#define FONT_TITLE &FreeSansBold12pt7b  // Títulos de pantalla y botón
#define FONT_BIG   &FreeSansBold18pt7b  // Número grande de potencia
#define FONT_VALUE &FreeSansBold9pt7b   // Voltaje / Corriente / Energía al cargar

// =====================================================
// CARGACERCA TERMINAL V3 - LIGHT MODE
// =====================================================

// =====================================================
// INA219 - I2C
// =====================================================

#define SDA_PIN 21
#define SCL_PIN 22

Adafruit_INA219 ina219;

// =====================================================
// PN532 - UART
// =====================================================

PN532_HSU pn532hsu(Serial2);
PN532 nfc(pn532hsu);

// =====================================================
// TFT
// =====================================================

#define TFT_CS   5
#define TFT_DC   27
#define TFT_RST  33

Adafruit_ILI9341 tft(TFT_CS, TFT_DC, TFT_RST);

// =====================================================
// TOUCH
// =====================================================

#define TOUCH_CS 25

XPT2046_Touchscreen ts(TOUCH_CS);

// Rango RAW aproximado. En la operación normal solo importa detectar un
// toque estable: el onboarding ya no depende de acertar coordenadas.
#define TS_MIN 200
#define TS_MAX 3900

#define SCREEN_W 320
#define SCREEN_H 240

#define TOUCH_MIN_Z 150

// El XPT2046 entrega los ejes cruzados en este módulo. Las coordenadas se
// conservan para diagnóstico por Serial, no para elegir letras o filas.
const bool TOUCH_SWAP_XY = true;

// Compatibilidad con la calibración de versiones anteriores. El nuevo
// onboarding no usa estas coordenadas, pero el botón de inicio las deja
// disponibles en el log de diagnóstico.
const int CAL_MARGIN = 30;
const int CAL_TL_X = CAL_MARGIN;
const int CAL_TL_Y = CAL_MARGIN;
const int CAL_BR_X = SCREEN_W - CAL_MARGIN;
const int CAL_BR_Y = SCREEN_H - CAL_MARGIN;
int touchCalX0 = TS_MIN;
int touchCalX1 = TS_MAX;
int touchCalY0 = TS_MIN;
int touchCalY1 = TS_MAX;

// =====================================================
// RELAY
// =====================================================

#define RELAY_PIN 26

#define RELAY_ON  LOW
#define RELAY_OFF HIGH

// =====================================================
// BACKEND
// =====================================================

// Antes eran const char* fijos ("TU_WIFI" / "TU_PASSWORD_WIFI" / "CC-001"):
// cada estación necesitaba su propio firmware compilado aparte (con su red
// WiFi y su número de cargador hardcodeados), un embole para instalar más
// de una — y peor todavía con el WiFi, porque cada estación se instala en
// la casa de un cliente distinto, con su propia red. Ahora los tres datos
// se piden una sola vez por pantalla táctil (ver CONFIGURACIÓN INICIAL más
// abajo) y quedan guardados en NVS: el mismo .bin sirve para cualquier
// estación, en cualquier casa.
String wifiSsid = "";
String wifiPassword = "";
String chargerId = "";
Preferences prefs;

const char* API_BASE_URL =
  "https://carga-cerca-dashboard-production.up.railway.app";

const unsigned long INTERVALO_ENVIO_MEDICION_MS = 2000;
unsigned long ultimoEnvioMedicionMs = 0;

const unsigned long INTERVALO_REINTENTO_WIFI_MS = 5000;
unsigned long ultimoIntentoWifiMs = 0;

String tarjetaActualUid = "";

// Nombre del cliente que pidió cargar desde la app (GET /request). Vive
// desde que aparece hasta que termina la carga (ver finalizarCarga()).
String nombreClienteActual = "";

const unsigned long INTERVALO_CONSULTA_SOLICITUD_MS = 3000;
unsigned long ultimaConsultaSolicitudMs = 0;

// =====================================================
// ESTADOS
// =====================================================

enum Estado {
  ESPERANDO_TARJETA,
  ESPERANDO_INICIO,
  CARGANDO
};

Estado estado = ESPERANDO_TARJETA;

// El backend marca el cargador "Desconectado" si no le llega NADA (ni
// medición ni estado) en config.status.offlineAfterMs (20s, ver config.js).
// enviarEstadoDispositivo() solo se llama en las transiciones de estado
// (tarjeta detectada, inicio, fin), así que un cargador que se queda
// esperando tarjeta mucho tiempo (el caso normal de "disponible") deja de
// avisar y termina viéndose desconectado aunque esté perfecto. Este
// heartbeat re-manda el estado actual cada pocos segundos para que nunca
// pase ese umbral mientras la ESP32 siga viva y con WiFi.
const unsigned long INTERVALO_HEARTBEAT_MS = 10000;
unsigned long ultimoHeartbeatMs = 0;

// =====================================================
// CARGA
// =====================================================

const float UMBRAL_CORRIENTE_A = 0.05;

const unsigned long GRACIA_INICIAL_MS = 10000;
const unsigned long TIEMPO_SIN_CARGA_MS = 3000;

unsigned long inicioCargaMs = 0;
unsigned long inicioSinCorrienteMs = 0;

// =====================================================
// REFRESCO UI
// =====================================================

const unsigned long INTERVALO_REFRESCO_PANTALLA_MS = 500;
unsigned long ultimoRefrescoPantallaMs = 0;

bool pantallaCargaDibujada = false;

// =====================================================
// ENERGÍA DE SESIÓN
// =====================================================

float energiaWhSesion = 0.0;
unsigned long ultimoCalculoEnergiaMs = 0;

// =====================================================
// BOTÓN
// =====================================================

// Solo para DIBUJAR el botón (posición/tamaño visual).
// La detección del toque NO usa estas coordenadas: ver botonInicioPresionado().
const int BTN_X = 25;
const int BTN_Y = 155;
const int BTN_W = 270;
const int BTN_H = 58;

// =====================================================
// PALETA LIGHT
// =====================================================

const uint16_t COLOR_BG          = 0xFFDF;
const uint16_t COLOR_CARD        = 0xFFFF;
const uint16_t COLOR_CARD_ALT    = 0xF7BE;

const uint16_t COLOR_GREEN       = 0x2587;
const uint16_t COLOR_GREEN_LIGHT = 0xD6F3;
const uint16_t COLOR_GREEN_DARK  = 0x1484;

const uint16_t COLOR_TEXT        = 0x2124;
const uint16_t COLOR_MUTED       = 0x7BEF;

const uint16_t COLOR_BLUE        = 0x3D7F;
const uint16_t COLOR_BORDER      = 0xDEFB;
const uint16_t COLOR_WARNING     = 0xFD20;

// =====================================================
// HELPERS UI
// =====================================================

// Texto centrado con la fuente CLÁSICA de Adafruit_GFX (pixelada, tamaño
// en múltiplos enteros). La seguimos usando para textos chicos/secundarios
// (subtítulos, etiquetas): a tamaño 1 se ve bien y no hay riesgo de que un
// texto grande no entre en su recuadro.
void textoCentrado(
  const String &texto,
  int y,
  int size,
  uint16_t color
) {
  // Por si el dibujo anterior dejó puesta una fuente vectorial.
  tft.setFont(NULL);

  tft.setTextSize(size);
  tft.setTextColor(color);

  int ancho = texto.length() * 6 * size;
  int x = (SCREEN_W - ancho) / 2;

  if (x < 0) x = 0;

  tft.setCursor(x, y);
  tft.print(texto);
}

// -----------------------------------------------------
// Helpers para las fuentes vectoriales (FreeSans*), usadas en la marca,
// los títulos y los números grandes.
//
// A diferencia de la fuente clásica, acá tft.setCursor(x,y) apoya la
// BASE del texto en "y", no la esquina superior izquierda. Con
// getTextBounds() medimos cuánto se desvía el dibujo real respecto de
// ese punto y así podemos seguir pensando "y = borde superior", como
// con la fuente clásica, sin tener que recalcular cada posición a mano.
// -----------------------------------------------------

void tituloIzquierda(
  const String &texto,
  int x,
  int yArriba,
  const GFXfont *font,
  uint16_t color
) {
  tft.setFont(font);
  tft.setTextColor(color);

  int16_t x1, y1;
  uint16_t w, h;

  tft.getTextBounds(
    texto,
    0,
    0,
    &x1,
    &y1,
    &w,
    &h
  );

  tft.setCursor(
    x - x1,
    yArriba - y1
  );

  tft.print(texto);
}

// -----------------------------------------------------

void tituloCentrado(
  const String &texto,
  int yArriba,
  const GFXfont *font,
  uint16_t color
) {
  tft.setFont(font);
  tft.setTextColor(color);

  int16_t x1, y1;
  uint16_t w, h;

  tft.getTextBounds(
    texto,
    0,
    0,
    &x1,
    &y1,
    &w,
    &h
  );

  int x = (SCREEN_W - (int)w) / 2 - x1;

  tft.setCursor(
    x,
    yArriba - y1
  );

  tft.print(texto);
}

// -----------------------------------------------------
// Centra un texto de un solo color dentro de un rectángulo
// (ancho Y alto). La usamos para el label del botón.
// -----------------------------------------------------

void tituloCentradoEnCaja(
  const String &texto,
  int rectX,
  int rectY,
  int rectW,
  int rectH,
  const GFXfont *font,
  uint16_t color
) {
  tft.setFont(font);
  tft.setTextColor(color);

  int16_t x1, y1;
  uint16_t w, h;

  tft.getTextBounds(
    texto,
    0,
    0,
    &x1,
    &y1,
    &w,
    &h
  );

  int cx = rectX + ((int)rectW - (int)w) / 2 - x1;
  int cy = rectY + ((int)rectH - (int)h) / 2 - y1;

  tft.setCursor(cx, cy);
  tft.print(texto);
}

// -----------------------------------------------------
// Centra "valor" + "unidad" (con colores distintos) dentro de un
// rectángulo. La usamos para los números de potencia/voltaje/corriente/
// energía: medimos el string COMPLETO para centrarlo bien, pero lo
// imprimimos en dos tandas para poder pintar la unidad de otro color.
// -----------------------------------------------------

void valorConUnidadCentrado(
  const String &valor,
  const String &unidad,
  int rectX,
  int rectY,
  int rectW,
  int rectH,
  const GFXfont *font,
  uint16_t colorValor,
  uint16_t colorUnidad
) {
  String completo = valor + unidad;

  tft.setFont(font);

  int16_t x1, y1;
  uint16_t w, h;

  tft.getTextBounds(
    completo,
    0,
    0,
    &x1,
    &y1,
    &w,
    &h
  );

  int cx = rectX + ((int)rectW - (int)w) / 2 - x1;
  int cy = rectY + ((int)rectH - (int)h) / 2 - y1;

  tft.setCursor(cx, cy);

  tft.setTextColor(colorValor);
  tft.print(valor);

  tft.setTextColor(colorUnidad);
  tft.print(unidad);
}

// -----------------------------------------------------

void dibujarHeader(
  const char* estadoTexto,
  uint16_t colorEstado
) {
  tituloIzquierda(
    "CargaCerca",
    15,
    12,
    FONT_BRAND,
    COLOR_TEXT
  );

  int pillW = 92;
  int pillH = 24;
  int pillX = 213;
  int pillY = 8;

  tft.fillRoundRect(
    pillX,
    pillY,
    pillW,
    pillH,
    12,
    COLOR_CARD
  );

  tft.drawRoundRect(
    pillX,
    pillY,
    pillW,
    pillH,
    12,
    COLOR_BORDER
  );

  tft.fillCircle(
    pillX + 12,
    pillY + 12,
    4,
    colorEstado
  );

  // Volvemos a la fuente clásica para el texto chico del pill.
  tft.setFont(NULL);

  tft.setTextColor(COLOR_MUTED);
  tft.setTextSize(1);
  tft.setCursor(
    pillX + 23,
    pillY + 9
  );
  tft.print(estadoTexto);

  tft.drawFastHLine(
    15,
    42,
    290,
    COLOR_BORDER
  );
}

// -----------------------------------------------------

void dibujarIconoNFC(
  int cx,
  int cy,
  uint16_t color
) {
  tft.drawCircle(cx, cy, 13, color);
  tft.drawCircle(cx, cy, 23, color);
  tft.drawCircle(cx, cy, 33, color);
  tft.fillCircle(cx, cy, 4, color);
}

// -----------------------------------------------------
// Ícono de celular: lo usamos en la pantalla de reposo (sin solicitud)
// para invitar a pedir la carga desde la app, en vez del ícono de NFC
// (que solo tiene sentido mostrar cuando ya hay alguien esperando y
// corresponde apoyar la tarjeta).
// -----------------------------------------------------

void dibujarIconoTelefono(
  int cx,
  int cy,
  uint16_t color
) {
  int w = 34;
  int h = 54;
  int x = cx - w / 2;
  int y = cy - h / 2;

  tft.drawRoundRect(x, y, w, h, 7, color);
  tft.drawRoundRect(x + 1, y + 1, w - 2, h - 2, 6, color);

  tft.fillRoundRect(cx - 8, y + h - 11, 16, 4, 2, color);
}

// -----------------------------------------------------

void dibujarRayo(
  int x,
  int y,
  uint16_t color
) {
  tft.fillTriangle(
    x + 14, y,
    x,      y + 25,
    x + 11, y + 25,
    color
  );

  tft.fillTriangle(
    x + 11, y + 25,
    x + 5,  y + 48,
    x + 28, y + 18,
    color
  );
}

// -----------------------------------------------------
// Recorta nombres largos para que entren en los títulos de la pantalla
// (fuente vectorial, no monoespaciada: mejor curarlo acá que arriesgar
// texto cortado o corrido fuera del recuadro).
// -----------------------------------------------------

String recortarNombre(const String &nombre) {
  const int LARGO_MAX = 20;

  if (nombre.length() <= LARGO_MAX) {
    return nombre;
  }

  return nombre.substring(0, LARGO_MAX - 1) + "...";
}

// =====================================================
// CONFIGURACIÓN INICIAL — CALIBRACIÓN TOUCH
// =====================================================
//
// Paso 0 del onboarding (ver setup()), antes que WiFi/contraseña/cargador:
// todos los pasos siguientes dependen de un touch bien calibrado, así que
// esto va primero. Se piden 2 toques (cruz arriba-izquierda, cruz abajo-
// derecha) y con eso alcanza para mapear RAW -> pantalla en esta placa
// (ver el bloque CALIBRACIÓN TOUCH, junto a TOUCH_MIN_Z, para el porqué).
// Igual que el resto del onboarding, se guarda en NVS y no se vuelve a
// pedir salvo que se borre la flash.

bool cargarCalibracionTouchGuardada() {
  prefs.begin("cargacerca", true); // true = solo lectura
  bool hay = prefs.isKey("touch_cal_x0");

  if (hay) {
    touchCalX0 = prefs.getInt("touch_cal_x0", TS_MIN);
    touchCalX1 = prefs.getInt("touch_cal_x1", TS_MAX);
    touchCalY0 = prefs.getInt("touch_cal_y0", TS_MIN);
    touchCalY1 = prefs.getInt("touch_cal_y1", TS_MAX);
  }

  prefs.end();
  return hay;
}

void guardarCalibracionTouch(int x0, int x1, int y0, int y1) {
  prefs.begin("cargacerca", false); // false = lectura/escritura
  prefs.putInt("touch_cal_x0", x0);
  prefs.putInt("touch_cal_x1", x1);
  prefs.putInt("touch_cal_y0", y0);
  prefs.putInt("touch_cal_y1", y1);
  prefs.end();
}

void dibujarPantallaCalibracion(int paso) {
  tft.fillScreen(COLOR_BG);

  dibujarHeader("SETUP", COLOR_BLUE);

  textoCentrado("Calibracion de pantalla", 48, 1, COLOR_MUTED);

  int tx = (paso == 0) ? CAL_TL_X : CAL_BR_X;
  int ty = (paso == 0) ? CAL_TL_Y : CAL_BR_Y;

  tft.drawFastHLine(tx - 10, ty, 20, COLOR_GREEN);
  tft.drawFastVLine(tx, ty - 10, 20, COLOR_GREEN);
  tft.drawCircle(tx, ty, 6, COLOR_GREEN);

  textoCentrado(
    paso == 0 ? "Toca el centro de la cruz" : "Toca el centro de esta otra cruz",
    120,
    1,
    COLOR_MUTED
  );

  textoCentrado(
    "Con el lapiz de la pantalla, con firmeza",
    132,
    1,
    COLOR_MUTED
  );
}

// Bloquea acá hasta juntar los 2 toques de calibración. Se llama una
// sola vez desde setup(), antes que cualquier otra pantalla táctil.
void calibrarTouchPorPantalla() {
  int rawTLx, rawTLy, rawBRx, rawBRy;

  dibujarPantallaCalibracion(0);

  while (!leerToqueRaw(rawTLx, rawTLy)) {
    delay(20);
  }

  dibujarPantallaCalibracion(1);

  while (!leerToqueRaw(rawBRx, rawBRy)) {
    delay(20);
  }

  touchCalX0 = rawTLx;
  touchCalX1 = rawBRx;
  touchCalY0 = rawTLy;
  touchCalY1 = rawBRy;

  guardarCalibracionTouch(touchCalX0, touchCalX1, touchCalY0, touchCalY1);
}

// =====================================================
// CONFIGURACIÓN INICIAL — WIFI
// =====================================================
//
// Primeros dos pasos del onboarding (ver setup()): elegir la red WiFi de
// la casa del cliente de una lista escaneada (evita errores de tipeo del
// nombre) y cargar su contraseña con un teclado alfanumérico en pantalla.
// Igual que el número de cargador, se piden una sola vez y quedan
// guardados en el mismo namespace de NVS.

String cargarWifiSsidGuardado() {
  prefs.begin("cargacerca", true); // true = solo lectura
  String v = prefs.getString("wifi_ssid", "");
  prefs.end();
  return v;
}

String cargarWifiPasswordGuardado() {
  prefs.begin("cargacerca", true);
  String v = prefs.getString("wifi_password", "");
  prefs.end();
  return v;
}

void guardarConfiguracionWifi(const String &ssid, const String &password) {
  prefs.begin("cargacerca", false); // false = lectura/escritura
  prefs.putString("wifi_ssid", ssid);
  prefs.putString("wifi_password", password);
  prefs.end();
}

// -----------------------------------------------------
// PASO 1: LISTA DE REDES
// -----------------------------------------------------

const int WIFI_MAX_REDES = 4;

const int WIFI_LIST_X0 = 10;
const int WIFI_LIST_Y0 = 62;
const int WIFI_LIST_W = 300;
const int WIFI_ROW_H = 28;
const int WIFI_ROW_GAP = 3;

int wifiFilaY(int fila) {
  return WIFI_LIST_Y0 + fila * (WIFI_ROW_H + WIFI_ROW_GAP);
}

// Escanea redes cercanas y devuelve hasta maxRedes nombres, sin
// duplicados, ordenados de señal más fuerte a más débil (lo más probable
// es que la red de la casa sea una de las primeras).
int escanearRedesWifi(String redes[], int maxRedes) {
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);

  int n = WiFi.scanNetworks();

  if (n <= 0) {
    return 0;
  }

  if (n > 30) {
    n = 30; // tope defensivo, no debería haber tantas redes vecinas
  }

  int orden[30];

  for (int i = 0; i < n; i++) {
    orden[i] = i;
  }

  // Orden simple por RSSI descendente: n es chico, no vale la pena algo
  // más elaborado que un selection sort.
  for (int i = 0; i < n - 1; i++) {
    for (int j = i + 1; j < n; j++) {
      if (WiFi.RSSI(orden[j]) > WiFi.RSSI(orden[i])) {
        int tmp = orden[i];
        orden[i] = orden[j];
        orden[j] = tmp;
      }
    }
  }

  int count = 0;

  for (int k = 0; k < n && count < maxRedes; k++) {
    String ssid = WiFi.SSID(orden[k]);

    if (ssid.length() == 0) {
      continue; // red oculta, no la mostramos (no se podría tipear igual)
    }

    bool yaEsta = false;

    for (int j = 0; j < count; j++) {
      if (redes[j] == ssid) {
        yaEsta = true;
        break;
      }
    }

    if (yaEsta) {
      continue; // mismo SSID visto por varios access points/canales
    }

    redes[count] = ssid;
    count++;
  }

  WiFi.scanDelete();

  return count;
}

void dibujarPantallaWifiLista(String redes[], int count, bool escaneando) {
  tft.fillScreen(COLOR_BG);

  dibujarHeader("SETUP", COLOR_BLUE);

  textoCentrado(
    "Elegi tu red WiFi",
    48,
    1,
    COLOR_MUTED
  );

  if (escaneando) {
    tituloCentrado("Buscando redes...", 120, FONT_TITLE, COLOR_TEXT);
    return;
  }

  if (count == 0) {
    tituloCentrado("No se encontraron redes", 100, FONT_TITLE, COLOR_TEXT);
  }

  for (int i = 0; i < count; i++) {
    int ry = wifiFilaY(i);

    tft.fillRoundRect(WIFI_LIST_X0, ry, WIFI_LIST_W, WIFI_ROW_H, 8, COLOR_CARD);
    tft.drawRoundRect(WIFI_LIST_X0, ry, WIFI_LIST_W, WIFI_ROW_H, 8, COLOR_BORDER);

    tft.setFont(NULL);
    tft.setTextSize(1);
    tft.setTextColor(COLOR_TEXT);
    tft.setCursor(WIFI_LIST_X0 + 12, ry + 10);
    tft.print(redes[i]);
  }

  int ryRescan = wifiFilaY(count);

  tft.fillRoundRect(WIFI_LIST_X0, ryRescan, WIFI_LIST_W, WIFI_ROW_H, 8, COLOR_CARD_ALT);
  tft.drawRoundRect(WIFI_LIST_X0, ryRescan, WIFI_LIST_W, WIFI_ROW_H, 8, COLOR_BORDER);

  tituloCentradoEnCaja(
    "Buscar de nuevo",
    WIFI_LIST_X0,
    ryRescan,
    WIFI_LIST_W,
    WIFI_ROW_H,
    FONT_VALUE,
    COLOR_BLUE
  );
}

// Devuelve la fila tocada (0..count-1 = red elegida, count = "buscar de
// nuevo"), o -1 si no hubo toque válido. Igual que leerToqueTeclado,
// espera a que se suelte el dedo antes de devolver una fila.
int leerToqueListaWifi(int count) {
  int x, y;

  if (!leerTouch(x, y)) {
    return -1;
  }

  int totalFilas = count + 1; // + botón de "buscar de nuevo"

  for (int fila = 0; fila < totalFilas; fila++) {
    int ry = wifiFilaY(fila);

    if (
      x >= WIFI_LIST_X0 && x <= WIFI_LIST_X0 + WIFI_LIST_W &&
      y >= ry && y <= ry + WIFI_ROW_H
    ) {
      while (ts.touched()) {
        delay(10);
      }

      return fila;
    }
  }

  return -1;
}

// Bloquea acá hasta que el instalador toque una red de la lista. Se llama
// una sola vez desde setup(), antes del teclado de la contraseña.
String pedirSsidPorPantalla() {
  String redes[WIFI_MAX_REDES];

  dibujarPantallaWifiLista(redes, 0, true);
  int count = escanearRedesWifi(redes, WIFI_MAX_REDES);
  dibujarPantallaWifiLista(redes, count, false);

  while (true) {
    int fila = leerToqueListaWifi(count);

    if (fila == -1) {
      delay(20);
      continue;
    }

    if (fila == count) {
      // "Buscar de nuevo"
      dibujarPantallaWifiLista(redes, count, true);
      count = escanearRedesWifi(redes, WIFI_MAX_REDES);
      dibujarPantallaWifiLista(redes, count, false);
      continue;
    }

    return redes[fila];
  }
}

// -----------------------------------------------------
// PASO 2: CONTRASEÑA (SELECTOR PAGINADO, BOTONES GRANDES)
// -----------------------------------------------------
//
// Primero probamos un QWERTY de 10 columnas (teclas de ~28px) y, aun
// calibrando el touch a mano en la placa (ver CALIBRACIÓN TOUCH), seguía
// fallando: con un touch resistivo barato el ruido/imprecisión de lectura
// es del mismo orden que el tamaño de esas teclas, calibrado o no. En vez
// de perseguir precisión que este sensor no puede dar, cambiamos el
// enfoque: la MISMA grilla grande de 4x3 que ya usa el teclado numérico
// (ver PWKB_* abajo, mismas medidas que TEC_* más adelante en el
// archivo), mostrando de a 8 caracteres por "página" con un botón
// "SIG >" para avanzar. Se escribe más lento que un QWERTY, pero es un
// trade-off correcto acá: la contraseña se carga UNA sola vez por
// estación, así que preferimos confiable-pero-lento a rápido-pero-frágil.
//
// Simplificación: la contraseña se muestra siempre en claro (sin opción
// de ocultar) — es una pantalla de instalador, de un solo uso, y sacar
// ese control deja más margen para los botones grandes. Si hace falta
// ocultarla, se puede volver a sumar como un control extra más adelante.

const int PASSWORD_MAX_LEN = 32;

// Mismas medidas que la grilla del teclado numérico (TEC_*, más abajo en
// el archivo) pero con su propio nombre: TEC_* todavía no existe en este
// punto del archivo y en C++ un const global tiene que estar declarado
// ANTES de usarse (a diferencia de las funciones, que Arduino
// auto-prototipa).
const int PWKB_X0 = 10;
const int PWKB_Y0 = 92;
const int PWKB_BTN_W = 96;
const int PWKB_BTN_H = 30;
const int PWKB_GAP = 6;

int pwBtnX(int columna) {
  return PWKB_X0 + columna * (PWKB_BTN_W + PWKB_GAP);
}

int pwBtnY(int fila) {
  return PWKB_Y0 + fila * (PWKB_BTN_H + PWKB_GAP);
}

// Charset como array (no puntero) para que sizeof() dé el largo real en
// tiempo de compilación, sin depender de strlen(). 56 caracteres, 8 por
// página = 7 páginas exactas.
const char PW_CHARSET[] = "abcdefghijklmnopqrstuvwxyz0123456789-_@#$%&*!?.,:;()+=/ ";
const int PW_CHARSET_LEN = sizeof(PW_CHARSET) - 1;
const int PW_CHARS_PER_PAGINA = 8;
const int PW_TOTAL_PAGINAS = PW_CHARSET_LEN / PW_CHARS_PER_PAGINA;

void dibujarPantallaPassword(
  const String &ssid,
  const String &password,
  int pagina,
  bool mayusculas
) {
  tft.fillScreen(COLOR_BG);

  dibujarHeader("SETUP", COLOR_BLUE);

  textoCentrado(
    "Contrasena de " + recortarNombre(ssid),
    46,
    1,
    COLOR_MUTED
  );

  tft.fillRoundRect(15, 56, 290, 20, 6, COLOR_CARD);
  tft.drawRoundRect(15, 56, 290, 20, 6, COLOR_BORDER);

  tft.setFont(NULL);
  tft.setTextSize(1);
  tft.setTextColor(COLOR_TEXT);
  tft.setCursor(22, 62);
  tft.print(password);

  char bufPagina[24];
  sprintf(bufPagina, "Pag %d/%d", pagina + 1, PW_TOTAL_PAGINAS);
  textoCentrado(bufPagina, 80, 1, COLOR_MUTED);

  int base = pagina * PW_CHARS_PER_PAGINA;

  // 8 caracteres de esta página, en las primeras 8 celdas de la grilla
  // (fila0: 3 celdas, fila1: 3 celdas, fila2: celdas 0 y 1 — la celda
  // fila2/columna2 queda para "SIG >", dibujada aparte más abajo).
  for (int i = 0; i < PW_CHARS_PER_PAGINA; i++) {
    int fila = i / 3;
    int columna = i % 3;

    char c = PW_CHARSET[base + i];
    String lbl = (c == ' ') ? "ESPC" : String(c);
    if (mayusculas) lbl.toUpperCase();

    int bx = pwBtnX(columna);
    int by = pwBtnY(fila);

    tft.fillRoundRect(bx, by, PWKB_BTN_W, PWKB_BTN_H, 8, COLOR_CARD);
    tft.drawRoundRect(bx, by, PWKB_BTN_W, PWKB_BTN_H, 8, COLOR_BORDER);

    tituloCentradoEnCaja(lbl, bx, by, PWKB_BTN_W, PWKB_BTN_H, FONT_TITLE, COLOR_TEXT);
  }

  int bxSig = pwBtnX(2);
  int bySig = pwBtnY(2);

  tft.fillRoundRect(bxSig, bySig, PWKB_BTN_W, PWKB_BTN_H, 8, COLOR_CARD_ALT);
  tft.drawRoundRect(bxSig, bySig, PWKB_BTN_W, PWKB_BTN_H, 8, COLOR_BORDER);
  tituloCentradoEnCaja("SIG >", bxSig, bySig, PWKB_BTN_W, PWKB_BTN_H, FONT_TITLE, COLOR_BLUE);

  // Fila de controles: igual disposición que el teclado numérico
  // (borrar a la izquierda, OK a la derecha), MAY en el medio.
  int bxBorrar = pwBtnX(0);
  int byControles = pwBtnY(3);

  tft.fillRoundRect(bxBorrar, byControles, PWKB_BTN_W, PWKB_BTN_H, 8, COLOR_CARD);
  tft.drawRoundRect(bxBorrar, byControles, PWKB_BTN_W, PWKB_BTN_H, 8, COLOR_BORDER);
  tituloCentradoEnCaja("<-", bxBorrar, byControles, PWKB_BTN_W, PWKB_BTN_H, FONT_TITLE, COLOR_WARNING);

  int bxMay = pwBtnX(1);

  tft.fillRoundRect(bxMay, byControles, PWKB_BTN_W, PWKB_BTN_H, 8, mayusculas ? COLOR_GREEN : COLOR_CARD);

  if (!mayusculas) {
    tft.drawRoundRect(bxMay, byControles, PWKB_BTN_W, PWKB_BTN_H, 8, COLOR_BORDER);
  }

  tituloCentradoEnCaja("MAY", bxMay, byControles, PWKB_BTN_W, PWKB_BTN_H, FONT_TITLE, mayusculas ? COLOR_BG : COLOR_BLUE);

  int bxOk = pwBtnX(2);

  tft.fillRoundRect(bxOk, byControles, PWKB_BTN_W, PWKB_BTN_H, 8, COLOR_GREEN);
  tituloCentradoEnCaja("OK", bxOk, byControles, PWKB_BTN_W, PWKB_BTN_H, FONT_TITLE, COLOR_BG);
}

// Mismo hit-test (por rectángulo) que leerToqueTeclado(), duplicado acá
// con PWKB_* en vez de TEC_* por el mismo motivo que pwBtnX()/pwBtnY():
// TEC_* todavía no existe en este punto del archivo.
bool leerToquePassword(int &filaTocada, int &columnaTocada) {
  int x, y;

  if (!leerTouch(x, y)) {
    return false;
  }

  for (int fila = 0; fila < 4; fila++) {
    for (int columna = 0; columna < 3; columna++) {
      int bx = pwBtnX(columna);
      int by = pwBtnY(fila);

      if (x >= bx && x <= bx + PWKB_BTN_W && y >= by && y <= by + PWKB_BTN_H) {
        filaTocada = fila;
        columnaTocada = columna;

        while (ts.touched()) {
          delay(10);
        }

        return true;
      }
    }
  }

  return false;
}

// Bloquea acá hasta que el instalador confirme la contraseña con "OK".
// Se llama una sola vez desde setup(), después de elegir el SSID.
String pedirPasswordPorPantalla(const String &ssid) {
  String password = "";
  int pagina = 0;
  bool mayusculas = false;

  dibujarPantallaPassword(ssid, password, pagina, mayusculas);

  while (true) {
    int fila, columna;

    if (!leerToquePassword(fila, columna)) {
      delay(20);
      continue;
    }

    if (fila == 3 && columna == 0) {
      if (password.length() > 0) {
        password.remove(password.length() - 1);
      }
    } else if (fila == 3 && columna == 1) {
      mayusculas = !mayusculas;
    } else if (fila == 3 && columna == 2) {
      return password;
    } else if (fila == 2 && columna == 2) {
      pagina = (pagina + 1) % PW_TOTAL_PAGINAS;
    } else {
      int idx = fila * 3 + columna; // 0..7, cae siempre en una celda de caracter
      char c = PW_CHARSET[pagina * PW_CHARS_PER_PAGINA + idx];
      if (mayusculas) c = toupper(c);
      if (password.length() < PASSWORD_MAX_LEN) password += c;
    }

    dibujarPantallaPassword(ssid, password, pagina, mayusculas);
  }
}

// =====================================================
// CONFIGURACIÓN INICIAL — NÚMERO DE CARGADOR
// =====================================================
//
// Se corre UNA sola vez, la primera vez que se enciende una estación
// nueva (o después de borrar su flash): el instalador toca el número
// (1, 2, 102...) en un teclado numérico en la propia pantalla táctil, y
// eso queda guardado en NVS (memoria no volátil del ESP32) como
// "CC-XXX". En los arranques siguientes ya está guardado y esta pantalla
// ni se muestra. Así el mismo .bin sirve para cualquier cargador: ya no
// hace falta recompilar con un CHARGER_ID distinto por estación.

String cargarChargerIdGuardado() {
  prefs.begin("cargacerca", true); // true = solo lectura
  String v = prefs.getString("charger_id", "");
  prefs.end();
  return v;
}

void guardarChargerId(const String &id) {
  prefs.begin("cargacerca", false); // false = lectura/escritura
  prefs.putString("charger_id", id);
  prefs.end();
}

// Grilla 4 filas x 3 columnas. Los botones son grandes a propósito: el
// touch del XPT2046 no está calibrado pixel a pixel (ver leerTouch), así
// que conviene que cada botón tenga margen de sobra para tolerar el error.
const int TEC_X0 = 10;
const int TEC_Y0 = 92;
const int TEC_BTN_W = 96;
const int TEC_BTN_H = 30;
const int TEC_GAP = 6;

const char* TEC_LABELS[4][3] = {
  { "1", "2", "3" },
  { "4", "5", "6" },
  { "7", "8", "9" },
  { "<-", "0", "OK" }
};

int tecBtnX(int columna) {
  return TEC_X0 + columna * (TEC_BTN_W + TEC_GAP);
}

int tecBtnY(int fila) {
  return TEC_Y0 + fila * (TEC_BTN_H + TEC_GAP);
}

void dibujarPantallaConfiguracion(const String &digitos) {
  tft.fillScreen(COLOR_BG);

  dibujarHeader("SETUP", COLOR_BLUE);

  textoCentrado(
    "Numero de cargador (ej: 1, 2, 102)",
    48,
    1,
    COLOR_MUTED
  );

  String preview = "CC-";

  if (digitos.length() == 0) {
    preview += "___";
  } else {
    char buf[8];
    sprintf(buf, "%03d", digitos.toInt());
    preview += buf;
  }

  tituloCentrado(
    preview,
    62,
    FONT_TITLE,
    COLOR_TEXT
  );

  for (int fila = 0; fila < 4; fila++) {
    for (int columna = 0; columna < 3; columna++) {
      const char* label = TEC_LABELS[fila][columna];
      bool esOk = (fila == 3 && columna == 2);
      bool esBorrar = (fila == 3 && columna == 0);

      uint16_t colorFondo = esOk ? COLOR_GREEN : COLOR_CARD;
      uint16_t colorTexto = esOk ? COLOR_BG : (esBorrar ? COLOR_WARNING : COLOR_TEXT);

      int bx = tecBtnX(columna);
      int by = tecBtnY(fila);

      tft.fillRoundRect(bx, by, TEC_BTN_W, TEC_BTN_H, 8, colorFondo);

      if (!esOk) {
        tft.drawRoundRect(bx, by, TEC_BTN_W, TEC_BTN_H, 8, COLOR_BORDER);
      }

      tituloCentradoEnCaja(
        String(label),
        bx,
        by,
        TEC_BTN_W,
        TEC_BTN_H,
        FONT_TITLE,
        colorTexto
      );
    }
  }
}

// Devuelve por referencia la celda tocada (fila/columna) de la grilla del
// teclado, o false si no hubo toque válido / cayó fuera de todos los
// botones. Espera a que se suelte el dedo antes de devolver true, para
// que un solo toque no se cuente varias veces.
bool leerToqueTeclado(int &filaTocada, int &columnaTocada) {
  int x, y;

  if (!leerTouch(x, y)) {
    return false;
  }

  for (int fila = 0; fila < 4; fila++) {
    for (int columna = 0; columna < 3; columna++) {
      int bx = tecBtnX(columna);
      int by = tecBtnY(fila);

      if (x >= bx && x <= bx + TEC_BTN_W && y >= by && y <= by + TEC_BTN_H) {
        filaTocada = fila;
        columnaTocada = columna;

        while (ts.touched()) {
          delay(10);
        }

        return true;
      }
    }
  }

  return false;
}

// Bloquea acá (con su propio loop) hasta que el instalador confirme un
// número con "OK". Se llama una sola vez, desde setup(), antes de que
// arranque el loop() normal de la máquina de estados de carga.
String pedirNumeroCargadorPorPantalla() {
  const int MAX_DIGITOS = 3;
  String digitos = "";

  dibujarPantallaConfiguracion(digitos);

  while (true) {
    int fila, columna;

    if (!leerToqueTeclado(fila, columna)) {
      delay(20);
      continue;
    }

    bool esBorrar = (fila == 3 && columna == 0);
    bool esCero = (fila == 3 && columna == 1);
    bool esOk = (fila == 3 && columna == 2);

    if (esOk) {
      if (digitos.length() == 0) {
        continue; // nada cargado todavía, ignoramos el OK
      }

      char buf[8];
      sprintf(buf, "CC-%03d", digitos.toInt());
      return String(buf);
    }

    if (esBorrar) {
      if (digitos.length() > 0) {
        digitos.remove(digitos.length() - 1);
      }
    } else if (digitos.length() < MAX_DIGITOS) {
      digitos += esCero ? "0" : String(TEC_LABELS[fila][columna]);
    }

    dibujarPantallaConfiguracion(digitos);
  }
}

// =====================================================
// ONBOARDING ROBUSTO — PORTAL DESDE EL CELULAR
// =====================================================
//
// Una pantalla resistiva de 4 hilos sirve bien para botones grandes, pero
// no para un teclado QWERTY ni para filas angostas. Por eso el alta inicial
// ya no pide coordenadas precisas: la estación crea temporalmente una red
// WiFi y sirve un formulario que se completa desde el celular. La pantalla
// del cargador queda como guía y estado del proceso.

const char* SETUP_AP_PASSWORD = "cargacerca";
const int SETUP_MAX_REDES = 12;

String escaparHtml(const String &valor) {
  String salida;
  salida.reserve(valor.length() + 12);

  for (unsigned int i = 0; i < valor.length(); i++) {
    char c = valor.charAt(i);
    if (c == '&') salida += F("&amp;");
    else if (c == '<') salida += F("&lt;");
    else if (c == '>') salida += F("&gt;");
    else if (c == '"') salida += F("&quot;");
    else if (c == '\'') salida += F("&#39;");
    else salida += c;
  }

  return salida;
}

String normalizarNumeroCargador(String numero) {
  numero.trim();

  if (numero.startsWith("CC-") || numero.startsWith("cc-")) {
    numero = numero.substring(3);
  }

  if (numero.length() == 0 || numero.length() > 3) return "";

  for (unsigned int i = 0; i < numero.length(); i++) {
    if (!isDigit(numero.charAt(i))) return "";
  }

  int valor = numero.toInt();
  if (valor < 1 || valor > 999) return "";

  char buf[8];
  sprintf(buf, "CC-%03d", valor);
  return String(buf);
}

String crearNombreRedSetup() {
  uint64_t chip = ESP.getEfuseMac();
  char nombre[25];
  sprintf(nombre, "CargaCerca-%04X", (uint16_t)(chip & 0xFFFF));
  return String(nombre);
}

void dibujarGuiaOnboarding(const String &redSetup) {
  tft.fillScreen(COLOR_BG);
  dibujarHeader("CONFIG", COLOR_BLUE);

  tituloCentrado("Configurar con el celular", 55, FONT_TITLE, COLOR_TEXT);

  tft.fillRoundRect(14, 88, 292, 116, 12, COLOR_CARD);
  tft.drawRoundRect(14, 88, 292, 116, 12, COLOR_BORDER);

  tituloIzquierda("1  Conectate a:", 28, 101, FONT_VALUE, COLOR_MUTED);
  tituloIzquierda(redSetup, 28, 124, FONT_VALUE, COLOR_TEXT);
  tituloIzquierda("2  Clave: cargacerca", 28, 151, FONT_VALUE, COLOR_TEXT);
  tituloIzquierda("3  Abri: 192.168.4.1", 28, 178, FONT_VALUE, COLOR_BLUE);

  textoCentrado("No hace falta tocar esta pantalla", 218, 1, COLOR_MUTED);
}

void dibujarEstadoOnboarding(const String &titulo, const String &detalle, uint16_t color) {
  tft.fillScreen(COLOR_BG);
  dibujarHeader("CONFIG", color);
  tituloCentrado(titulo, 78, FONT_TITLE, COLOR_TEXT);
  textoCentrado(detalle, 116, 1, COLOR_MUTED);
}

// Para cambiar una configuración todavía válida: mantener apoyado el lápiz
// mientras se enciende. Solo importa que haya presión, nunca la coordenada.
bool reconfiguracionSolicitadaAlArrancar() {
  if (!ts.touched()) return false;

  dibujarEstadoOnboarding("Reconfigurar", "Manten presionado 2 segundos", COLOR_BLUE);
  unsigned long inicio = millis();

  while (ts.touched() && millis() - inicio < 2200) {
    delay(20);
  }

  bool confirmada = millis() - inicio >= 1800;

  while (ts.touched()) delay(10);
  return confirmada;
}

int escanearRedesParaPortal(String redes[], int maxRedes) {
  int encontradas = WiFi.scanNetworks();
  int cantidad = 0;

  for (int i = 0; i < encontradas && cantidad < maxRedes; i++) {
    String ssid = WiFi.SSID(i);
    if (ssid.length() == 0) continue;

    bool repetida = false;
    for (int j = 0; j < cantidad; j++) {
      if (redes[j] == ssid) {
        repetida = true;
        break;
      }
    }

    if (!repetida) redes[cantidad++] = ssid;
  }

  WiFi.scanDelete();
  return cantidad;
}

String paginaFormularioSetup(
  const String redes[],
  int cantidadRedes,
  const String &mensaje
) {
  String html;
  html.reserve(6500);
  html += F("<!doctype html><html lang='es'><head><meta charset='utf-8'>");
  html += F("<meta name='viewport' content='width=device-width,initial-scale=1'>");
  html += F("<title>Configurar CargaCerca</title><style>");
  html += F("*{box-sizing:border-box}body{margin:0;background:#f5f7f6;color:#1d2924;font-family:system-ui,sans-serif}");
  html += F("main{max-width:520px;margin:auto;padding:24px 18px}h1{margin:0 0 6px;font-size:28px}p{color:#607068;margin:0 0 24px}");
  html += F("form{background:white;border:1px solid #dce5e0;border-radius:18px;padding:20px;box-shadow:0 10px 30px #183b2b12}");
  html += F("label{display:block;font-weight:700;margin:18px 0 7px}input{width:100%;min-height:52px;border:2px solid #cad7d0;border-radius:12px;padding:0 14px;font-size:18px}");
  html += F("input:focus{outline:3px solid #86d7ad;border-color:#23845a}button{width:100%;min-height:56px;margin-top:24px;border:0;border-radius:14px;background:#23845a;color:white;font-size:18px;font-weight:800}");
  html += F(".aviso{background:#fff2cf;color:#674d00;padding:12px;border-radius:10px;margin-bottom:12px}.ayuda{font-size:14px;margin-top:7px;color:#607068}</style></head><body><main>");
  html += F("<h1>CargaCerca</h1><p>Configura la estacion sin usar el teclado resistivo.</p>");

  if (mensaje.length() > 0) {
    html += F("<div class='aviso'>");
    html += escaparHtml(mensaje);
    html += F("</div>");
  }

  html += F("<form method='post' action='/guardar' autocomplete='off'>");
  html += F("<label for='ssid'>Red WiFi</label><input id='ssid' name='ssid' list='redes' maxlength='32' required placeholder='Elegir o escribir red'><datalist id='redes'>");

  for (int i = 0; i < cantidadRedes; i++) {
    html += F("<option value=\"");
    html += escaparHtml(redes[i]);
    html += F("\"></option>");
  }

  html += F("</datalist><div class='ayuda'>Si no aparece, tambien podes escribir el nombre.</div>");
  html += F("<label for='password'>Clave WiFi</label><input id='password' name='password' type='password' maxlength='64' autocapitalize='none' spellcheck='false'>");
  html += F("<label for='charger'>Numero de cargador</label><input id='charger' name='charger' type='number' inputmode='numeric' min='1' max='999' required placeholder='Ejemplo: 1' value='");
  if (chargerId.startsWith("CC-")) html += escaparHtml(chargerId.substring(3));
  html += F("'>");
  html += F("<button type='submit'>Probar y guardar</button></form></main></body></html>");
  return html;
}

String paginaEstadoSetup(const String &titulo, const String &detalle, bool recargar) {
  String html;
  html.reserve(1800);
  html += F("<!doctype html><html lang='es'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>");
  if (recargar) html += F("<meta http-equiv='refresh' content='2;url=/estado'>");
  html += F("<style>body{margin:0;background:#f5f7f6;color:#1d2924;font-family:system-ui,sans-serif;text-align:center;padding:60px 20px}section{max-width:460px;margin:auto;background:white;padding:28px;border-radius:18px;border:1px solid #dce5e0}h1{font-size:25px}p{color:#607068;line-height:1.5}a{display:block;margin-top:24px;padding:16px;background:#23845a;color:white;border-radius:12px;text-decoration:none;font-weight:800}</style></head><body><section><h1>");
  html += escaparHtml(titulo);
  html += F("</h1><p>");
  html += escaparHtml(detalle);
  html += F("</p>");
  if (!recargar) html += F("<a href='/'>Volver a intentar</a>");
  html += F("</section></body></html>");
  return html;
}

// Bloquea solo durante la instalación. Mantiene el AP, DNS y servidor web
// atendidos incluso mientras prueba las credenciales recibidas.
void ejecutarOnboardingDesdeCelular() {
  String redSetup = crearNombreRedSetup();
  String redes[SETUP_MAX_REDES];
  String ssidCandidato;
  String passwordCandidato;
  String chargerIdCandidato;
  String errorFormulario;
  String detalleEstado = "Esperando los datos del formulario.";
  bool solicitudPendiente = false;
  bool probando = false;
  bool configuracionLista = false;

  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(redSetup.c_str(), SETUP_AP_PASSWORD);

  IPAddress ipSetup = WiFi.softAPIP();
  DNSServer dns;
  WebServer servidor(80);
  dns.start(53, "*", ipSetup);

  dibujarGuiaOnboarding(redSetup);
  int cantidadRedes = escanearRedesParaPortal(redes, SETUP_MAX_REDES);

  auto enviarFormulario = [&]() {
    servidor.sendHeader("Cache-Control", "no-store");
    servidor.send(200, "text/html; charset=utf-8", paginaFormularioSetup(redes, cantidadRedes, errorFormulario));
  };

  servidor.on("/", HTTP_GET, enviarFormulario);
  servidor.on("/hotspot-detect.html", HTTP_GET, enviarFormulario);
  servidor.on("/generate_204", HTTP_GET, enviarFormulario);
  servidor.on("/guardar", HTTP_POST, [&]() {
    String ssid = servidor.arg("ssid");
    String password = servidor.arg("password");
    String idNormalizado = normalizarNumeroCargador(servidor.arg("charger"));

    if (ssid.length() == 0 || ssid.length() > 32) {
      errorFormulario = "El nombre de la red no es valido.";
      enviarFormulario();
      return;
    }

    if (password.length() > 64) {
      errorFormulario = "La clave WiFi es demasiado larga.";
      enviarFormulario();
      return;
    }

    if (idNormalizado.length() == 0) {
      errorFormulario = "El numero de cargador debe estar entre 1 y 999.";
      enviarFormulario();
      return;
    }

    ssidCandidato = ssid;
    passwordCandidato = password;
    chargerIdCandidato = idNormalizado;
    errorFormulario = "";
    detalleEstado = "La estacion esta comprobando la red. Esta pagina se actualiza sola.";
    solicitudPendiente = true;
    probando = true;
    servidor.send(200, "text/html; charset=utf-8", paginaEstadoSetup("Probando conexion...", detalleEstado, true));
  });

  servidor.on("/estado", HTTP_GET, [&]() {
    if (configuracionLista) {
      servidor.send(200, "text/html; charset=utf-8", paginaEstadoSetup("Configuracion lista", "Ya podes cerrar esta pagina y volver a la red WiFi habitual.", true));
    } else if (probando) {
      servidor.send(200, "text/html; charset=utf-8", paginaEstadoSetup("Probando conexion...", detalleEstado, true));
    } else {
      servidor.send(200, "text/html; charset=utf-8", paginaEstadoSetup("No se pudo conectar", detalleEstado, false));
    }
  });

  servidor.onNotFound(enviarFormulario);
  servidor.begin();

  while (!configuracionLista) {
    dns.processNextRequest();
    servidor.handleClient();

    if (!solicitudPendiente) {
      delay(5);
      continue;
    }

    solicitudPendiente = false;
    dibujarEstadoOnboarding("Probando WiFi...", ssidCandidato, COLOR_BLUE);

    WiFi.disconnect(false, false);
    WiFi.begin(ssidCandidato.c_str(), passwordCandidato.c_str());

    unsigned long inicioPrueba = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - inicioPrueba < 18000) {
      dns.processNextRequest();
      servidor.handleClient();
      delay(20);
    }

    if (WiFi.status() == WL_CONNECTED) {
      wifiSsid = ssidCandidato;
      wifiPassword = passwordCandidato;
      chargerId = chargerIdCandidato;
      guardarConfiguracionWifi(wifiSsid, wifiPassword);
      guardarChargerId(chargerId);
      configuracionLista = true;
      probando = false;
      dibujarEstadoOnboarding("Configuracion lista", "WiFi conectado correctamente", COLOR_GREEN);
    } else {
      WiFi.disconnect(false, false);
      probando = false;
      detalleEstado = "Revisa el nombre y la clave. Tu celular sigue conectado a CargaCerca.";
      errorFormulario = detalleEstado;
      dibujarGuiaOnboarding(redSetup);
    }
  }

  // Da tiempo al celular para recibir la confirmación final.
  unsigned long inicioConfirmacion = millis();
  while (millis() - inicioConfirmacion < 3500) {
    dns.processNextRequest();
    servidor.handleClient();
    delay(10);
  }

  servidor.stop();
  dns.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
}

// =====================================================
// PANTALLA INICIAL
// =====================================================

void pantallaEsperando() {
  pantallaCargaDibujada = false;

  tft.fillScreen(COLOR_BG);

  dibujarHeader(
    "LISTO",
    COLOR_GREEN
  );

  tft.fillRoundRect(
    20,
    58,
    280,
    130,
    16,
    COLOR_CARD
  );

  tft.drawRoundRect(
    20,
    58,
    280,
    130,
    16,
    COLOR_BORDER
  );

  tft.fillCircle(
    160,
    105,
    41,
    COLOR_GREEN_LIGHT
  );

  // Si alguien pidió cargar desde la app (ver obtenerNombreSolicitudPendiente),
  // lo saludamos por nombre y mostramos el ícono de NFC (ahora sí corresponde
  // apoyar la tarjeta). Si no, el cargador está en reposo: no tiene sentido
  // invitar a acercar la tarjeta porque el lector la va a rechazar (ver
  // pantallaTarjetaSinSolicitud), así que invitamos a usar la app.
  if (nombreClienteActual.length() > 0) {
    dibujarIconoNFC(
      160,
      105,
      COLOR_GREEN
    );

    tituloCentrado(
      "Hola, " + recortarNombre(nombreClienteActual),
      148,
      FONT_TITLE,
      COLOR_TEXT
    );

    textoCentrado(
      "apoya tu tarjeta para continuar",
      171,
      1,
      COLOR_MUTED
    );
  } else {
    dibujarIconoTelefono(
      160,
      105,
      COLOR_GREEN
    );

    tituloCentrado(
      "Pedila desde la app",
      148,
      FONT_TITLE,
      COLOR_TEXT
    );

    textoCentrado(
      "para habilitar la carga",
      171,
      1,
      COLOR_MUTED
    );
  }

  tft.fillRoundRect(
    57,
    207,
    206,
    22,
    11,
    COLOR_CARD
  );

  tft.drawRoundRect(
    57,
    207,
    206,
    22,
    11,
    COLOR_BORDER
  );

  tft.fillCircle(
    72,
    218,
    4,
    COLOR_GREEN
  );

  tft.setTextColor(COLOR_MUTED);
  tft.setTextSize(1);
  tft.setCursor(83, 215);
  tft.print(
    nombreClienteActual.length() > 0
      ? "Te estamos esperando"
      : "Cargador disponible"
  );
}

// =====================================================
// TARJETA SIN SOLICITUD PREVIA
// =====================================================

// Se apoyó una tarjeta pero nadie pidió cargar desde la app todavía.
// Mostramos el aviso un rato corto (ver loop(), rama ESPERANDO_TARJETA)
// y volvemos a pantallaEsperando() sin cambiar de estado ni tocar el relé.
void pantallaTarjetaSinSolicitud() {
  pantallaCargaDibujada = false;

  tft.fillScreen(COLOR_BG);

  dibujarHeader(
    "BLOQUEADO",
    COLOR_WARNING
  );

  tft.fillRoundRect(
    20,
    58,
    280,
    130,
    16,
    COLOR_CARD
  );

  tft.drawRoundRect(
    20,
    58,
    280,
    130,
    16,
    COLOR_BORDER
  );

  tft.fillCircle(
    160,
    100,
    28,
    COLOR_CARD_ALT
  );

  tft.drawCircle(
    160,
    100,
    28,
    COLOR_WARNING
  );

  tft.setFont(NULL);
  tft.setTextColor(COLOR_WARNING);
  tft.setTextSize(3);
  tft.setCursor(154, 86);
  tft.print("!");

  // tituloCentrado() usa una fuente vectorial (FreeSans*), pero no toca
  // setTextSize(): si lo dejamos en 3 (recién usado para el "!" de arriba),
  // el título sale gigante y se corta. Con las fuentes vectoriales el
  // tamaño correcto es siempre 1.
  tft.setTextSize(1);

  tituloCentrado(
    "Pedila desde la app",
    148,
    FONT_TITLE,
    COLOR_TEXT
  );

  textoCentrado(
    "Toca 'Quiero cargar mi auto'",
    171,
    1,
    COLOR_MUTED
  );
}

// =====================================================
// VALIDANDO TARJETA
// =====================================================

// Se dibuja apenas el lector detecta una tarjeta, ANTES de consultar al
// backend si hay una solicitud pendiente (esa consulta es de red y puede
// tardar hasta un par de segundos — ver loop(), rama ESPERANDO_TARJETA).
// Sin esto la pantalla se queda "congelada" ese rato, como si no hubiera
// pasado nada.
void pantallaValidando() {
  pantallaCargaDibujada = false;

  tft.fillScreen(COLOR_BG);

  dibujarHeader(
    "VALIDANDO",
    COLOR_BLUE
  );

  tft.fillRoundRect(
    20,
    58,
    280,
    130,
    16,
    COLOR_CARD
  );

  tft.drawRoundRect(
    20,
    58,
    280,
    130,
    16,
    COLOR_BORDER
  );

  tft.fillCircle(
    160,
    105,
    41,
    COLOR_GREEN_LIGHT
  );

  dibujarIconoNFC(
    160,
    105,
    COLOR_GREEN
  );

  tituloCentrado(
    "Validando...",
    148,
    FONT_TITLE,
    COLOR_TEXT
  );

  textoCentrado(
    "Un momento",
    171,
    1,
    COLOR_MUTED
  );
}

// =====================================================
// TARJETA DETECTADA
// =====================================================

void pantallaIniciar() {
  pantallaCargaDibujada = false;

  tft.fillScreen(COLOR_BG);

  dibujarHeader(
    "VALIDADO",
    COLOR_GREEN
  );

  tft.fillCircle(
    160,
    77,
    25,
    COLOR_GREEN_LIGHT
  );

  tft.drawCircle(
    160,
    77,
    25,
    COLOR_GREEN
  );

  tft.drawLine(
    149,
    77,
    157,
    85,
    COLOR_GREEN
  );

  tft.drawLine(
    157,
    85,
    173,
    68,
    COLOR_GREEN
  );

  tituloCentrado(
    "Tarjeta detectada",
    109,
    FONT_TITLE,
    COLOR_TEXT
  );

  if (nombreClienteActual.length() > 0) {
    textoCentrado(
      "Hola " + recortarNombre(nombreClienteActual) + ", inicia la carga",
      132,
      1,
      COLOR_MUTED
    );
  } else {
    textoCentrado(
      "Podes iniciar la carga",
      132,
      1,
      COLOR_MUTED
    );
  }

  tft.fillRoundRect(
    BTN_X,
    BTN_Y,
    BTN_W,
    BTN_H,
    14,
    COLOR_GREEN
  );

  dibujarRayo(
    BTN_X + 38,
    BTN_Y + 6,
    COLOR_BG
  );

  // Label centrado en el espacio libre a la derecha del rayo (para no
  // superponerse con el ícono).
  tituloCentradoEnCaja(
    "INICIAR CARGA",
    BTN_X + 75,
    BTN_Y,
    BTN_W - 75 - 10,
    BTN_H,
    FONT_TITLE,
    COLOR_BG
  );
}

// =====================================================
// CARGA BASE
// =====================================================

void pantallaCargaBase() {
  tft.fillScreen(COLOR_BG);

  dibujarHeader(
    "CARGANDO",
    COLOR_GREEN
  );

  tft.fillRoundRect(
    15,
    55,
    290,
    82,
    16,
    COLOR_CARD
  );

  tft.drawRoundRect(
    15,
    55,
    290,
    82,
    16,
    COLOR_BORDER
  );

  tft.setTextColor(COLOR_MUTED);
  tft.setTextSize(1);
  tft.setCursor(30, 70);
  tft.print("POTENCIA ACTUAL");

  tft.fillRoundRect(
    15,
    147,
    92,
    58,
    12,
    COLOR_CARD
  );

  tft.fillRoundRect(
    114,
    147,
    92,
    58,
    12,
    COLOR_CARD
  );

  tft.fillRoundRect(
    213,
    147,
    92,
    58,
    12,
    COLOR_CARD
  );

  tft.drawRoundRect(
    15,
    147,
    92,
    58,
    12,
    COLOR_BORDER
  );

  tft.drawRoundRect(
    114,
    147,
    92,
    58,
    12,
    COLOR_BORDER
  );

  tft.drawRoundRect(
    213,
    147,
    92,
    58,
    12,
    COLOR_BORDER
  );

  tft.setTextColor(COLOR_MUTED);
  tft.setTextSize(1);

  tft.setCursor(29, 158);
  tft.print("VOLTAJE");

  tft.setCursor(126, 158);
  tft.print("CORRIENTE");

  tft.setCursor(228, 158);
  tft.print("ENERGIA");

  tft.setCursor(57, 222);
  tft.print("Desconecta para finalizar");

  pantallaCargaDibujada = true;
}

// =====================================================
// ACTUALIZAR DATOS SIN TITILEO
// =====================================================

void actualizarDatosCarga(
  float voltaje,
  float corrienteA,
  float potenciaW
) {
  if (!pantallaCargaDibujada) {
    pantallaCargaBase();
  }

  // Potencia (número grande, fuente moderna)
  tft.fillRect(
    27,
    87,
    265,
    40,
    COLOR_CARD
  );

  valorConUnidadCentrado(
    String(potenciaW, 2),
    " W",
    27,
    87,
    265,
    40,
    FONT_BIG,
    COLOR_TEXT,
    COLOR_GREEN
  );

  // Voltaje
  tft.fillRect(
    23,
    175,
    77,
    22,
    COLOR_CARD
  );

  valorConUnidadCentrado(
    String(voltaje, 2),
    " V",
    23,
    175,
    77,
    22,
    FONT_VALUE,
    COLOR_TEXT,
    COLOR_TEXT
  );

  // Corriente
  tft.fillRect(
    120,
    175,
    80,
    22,
    COLOR_CARD
  );

  valorConUnidadCentrado(
    String(corrienteA, 2),
    " A",
    120,
    175,
    80,
    22,
    FONT_VALUE,
    COLOR_TEXT,
    COLOR_TEXT
  );

  // Energía
  tft.fillRect(
    220,
    175,
    77,
    22,
    COLOR_CARD
  );

  valorConUnidadCentrado(
    String(energiaWhSesion, 2),
    " Wh",
    220,
    175,
    77,
    22,
    FONT_VALUE,
    COLOR_TEXT,
    COLOR_TEXT
  );
}

// =====================================================
// FINALIZADA
// =====================================================

void pantallaFinalizada() {
  pantallaCargaDibujada = false;

  tft.fillScreen(COLOR_BG);

  dibujarHeader(
    "FINALIZADA",
    COLOR_WARNING
  );

  tft.fillCircle(
    160,
    93,
    38,
    COLOR_GREEN_LIGHT
  );

  tft.drawCircle(
    160,
    93,
    38,
    COLOR_GREEN
  );

  tft.drawLine(
    142,
    93,
    154,
    105,
    COLOR_GREEN
  );

  tft.drawLine(
    154,
    105,
    180,
    78,
    COLOR_GREEN
  );

  tituloCentrado(
    "Carga finalizada",
    147,
    FONT_TITLE,
    COLOR_TEXT
  );

  // Volvemos a la fuente clásica para esta línea chica.
  tft.setFont(NULL);

  tft.setTextColor(COLOR_MUTED);
  tft.setTextSize(1);
  tft.setCursor(93, 179);
  tft.print("Energia: ");

  tft.setTextColor(COLOR_TEXT);
  tft.print(
    energiaWhSesion,
    2
  );

  tft.print(" Wh");

  if (nombreClienteActual.length() > 0) {
    textoCentrado(
      "Gracias por cargar, " + recortarNombre(nombreClienteActual) + "!",
      211,
      1,
      COLOR_MUTED
    );
  } else {
    textoCentrado(
      "Gracias por usar CargaCerca",
      211,
      1,
      COLOR_MUTED
    );
  }
}

// =====================================================
// WIFI
// =====================================================

void conectarWiFi() {
  Serial.print("Conectando a WiFi");

  WiFi.mode(WIFI_STA);
  WiFi.begin(
    wifiSsid.c_str(),
    wifiPassword.c_str()
  );

  unsigned long inicio = millis();

  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - inicio < 15000
  ) {
    delay(300);
    Serial.print(".");
  }

  Serial.println();

  if (
    WiFi.status() ==
    WL_CONNECTED
  ) {
    Serial.print("WiFi conectado. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi no conectado");
  }
}

// -----------------------------------------------------

void asegurarWiFi() {
  if (
    WiFi.status() ==
    WL_CONNECTED
  ) {
    return;
  }

  if (
    millis() -
    ultimoIntentoWifiMs <
    INTERVALO_REINTENTO_WIFI_MS
  ) {
    return;
  }

  ultimoIntentoWifiMs =
    millis();

  WiFi.reconnect();
}

// =====================================================
// UID
// =====================================================

String uidToHex(
  uint8_t *uid,
  uint8_t len
) {
  String out = "";

  for (
    uint8_t i = 0;
    i < len;
    i++
  ) {
    if (uid[i] < 0x10) {
      out += "0";
    }

    out += String(uid[i], HEX);

    if (i < len - 1) {
      out += ":";
    }
  }

  out.toUpperCase();

  return out;
}

// =====================================================
// BACKEND - ESTADO
// =====================================================

void enviarEstadoDispositivo(
  const char* estadoTexto,
  const String &cardUid
) {
  if (
    WiFi.status() !=
    WL_CONNECTED
  ) {
    return;
  }

  String url =
    String(API_BASE_URL) +
    "/api/chargers/" +
    chargerId +
    "/device-state";

  String json =
    "{\"state\":\"" +
    String(estadoTexto) +
    "\"";

  if (
    cardUid.length() > 0
  ) {
    json +=
      ",\"cardUid\":\"" +
      cardUid +
      "\"";
  }

  json += "}";

  HTTPClient http;

  http.begin(url);

  http.addHeader(
    "Content-Type",
    "application/json"
  );

  http.setTimeout(4000);

  int code =
    http.POST(json);

  Serial.print(
    "[backend] Estado HTTP "
  );
  Serial.println(code);

  http.end();
}

// -----------------------------------------------------

const char* estadoComoTexto(Estado e) {
  switch (e) {
    case ESPERANDO_TARJETA:
      return "esperando_tarjeta";
    case ESPERANDO_INICIO:
      return "esperando_inicio";
    case CARGANDO:
      return "cargando";
  }

  return "esperando_tarjeta";
}

// -----------------------------------------------------

// Re-manda el estado actual cada INTERVALO_HEARTBEAT_MS, sin importar en
// qué rama del loop() estemos. Sin esto, un cargador "disponible" (mucho
// tiempo en ESPERANDO_TARJETA sin que nadie apoye una tarjeta) deja de
// avisarle al backend y termina mostrándose "Desconectado" aunque esté
// perfecto — ver el comentario en la declaración de ultimoHeartbeatMs.
void heartbeat() {
  if (
    millis() -
    ultimoHeartbeatMs <
    INTERVALO_HEARTBEAT_MS
  ) {
    return;
  }

  ultimoHeartbeatMs =
    millis();

  enviarEstadoDispositivo(
    estadoComoTexto(estado),
    tarjetaActualUid
  );
}

// =====================================================
// BACKEND - MEDICIÓN
// =====================================================

void enviarMedicion(
  float sourceVoltage,
  float busVoltage,
  float shuntVoltageMv,
  float currentMa,
  float powerMw
) {
  if (
    WiFi.status() !=
    WL_CONNECTED
  ) {
    return;
  }

  String url =
    String(API_BASE_URL) +
    "/api/measurements";

  String json = "{";

  json +=
    "\"chargerId\":\"" +
    chargerId +
    "\",";

  json +=
    "\"sourceVoltage\":" +
    String(sourceVoltage, 2) +
    ",";

  json +=
    "\"busVoltage\":" +
    String(busVoltage, 2) +
    ",";

  json +=
    "\"shuntVoltageMv\":" +
    String(shuntVoltageMv, 2) +
    ",";

  json +=
    "\"currentMa\":" +
    String(currentMa, 2) +
    ",";

  json +=
    "\"powerMw\":" +
    String(powerMw, 2);

  json += "}";

  HTTPClient http;

  http.begin(url);

  http.addHeader(
    "Content-Type",
    "application/json"
  );

  http.setTimeout(4000);

  int code =
    http.POST(json);

  Serial.print(
    "[backend] Medicion HTTP "
  );
  Serial.println(code);

  http.end();
}

// =====================================================
// BACKEND - SOLICITUD DE CARGA
// =====================================================

// Parser mínimo: busca "campo":"valor" en un JSON plano (sin objetos ni
// arrays anidados, que es todo lo que manda nuestro backend). Alcanza
// para no sumar una librería de JSON solo para leer un string.
// Si el campo viene como null (sin comillas) devuelve "".
String extraerCampoStringJSON(
  const String &json,
  const String &campo
) {
  String buscado = "\"" + campo + "\":\"";

  int inicio = json.indexOf(buscado);

  if (inicio == -1) {
    return "";
  }

  inicio += buscado.length();

  int fin = json.indexOf('"', inicio);

  if (fin == -1) {
    return "";
  }

  return json.substring(inicio, fin);
}

// -----------------------------------------------------

// Consulta si hay un cliente esperando en este cargador (lo pidió desde
// la app con "Quiero cargar mi auto"). Devuelve su nombre, o "" si no
// hay nadie esperando (o hubo error de red).
String obtenerNombreSolicitudPendiente() {
  if (
    WiFi.status() !=
    WL_CONNECTED
  ) {
    return "";
  }

  String url =
    String(API_BASE_URL) +
    "/api/chargers/" +
    chargerId +
    "/request";

  HTTPClient http;

  http.begin(url);

  // Timeout corto a propósito: esta consulta corre en medio del loop que
  // escucha la tarjeta NFC (ver loop(), rama ESPERANDO_TARJETA). Si el
  // backend tarda o la red está mala, preferimos que falle rápido (nombre
  // "") y siga escuchando NFC, antes que quedar 4s sin poder leer tarjeta.
  http.setTimeout(2000);

  int code =
    http.GET();

  String nombre = "";

  if (code == 200) {
    nombre =
      extraerCampoStringJSON(
        http.getString(),
        "name"
      );
  }

  http.end();

  return nombre;
}

// =====================================================
// TOUCH
// =====================================================

// Cuántas muestras seguidas se piden por toque, y cuánto pueden diferir
// entre sí (en unidades RAW) para considerarlas "el mismo toque" y no
// ruido. TOUCH_TOLERANCIA_RAW ~120 equivale a un puñado de píxeles de
// jitter tolerado entre muestras — mucho menos que el ancho de un botón,
// pero bastante más que el ruido normal de una lectura estable.
const int TOUCH_MUESTRAS = 3;
const int TOUCH_TOLERANCIA_RAW = 120;

// Toda lectura de touch pasa por acá. Un XPT2046 barato, con el bus SPI
// compartido con la pantalla, puede tirar una lectura puntual disparada
// a cualquier valor por ruido eléctrico — confiar en un solo getPoint()
// es lo que hacía que tocar "C" resolviera en "H" (celdas que ni
// siquiera son vecinas: no es un error de calibración, es una lectura
// mala suelta). Acá se toman TOUCH_MUESTRAS lecturas seguidas y sólo se
// acepta el toque si todas caen dentro de TOUCH_TOLERANCIA_RAW entre sí;
// si no coinciden, se descarta (false) en vez de devolver cualquier cosa
// — mejor que el toque "no pase" a que pase mal.
bool leerToqueEstable(int &rawXOut, int &rawYOut) {
  digitalWrite(TFT_CS, HIGH);

  if (!ts.touched()) {
    return false;
  }

  int xs[TOUCH_MUESTRAS];
  int ys[TOUCH_MUESTRAS];

  for (int i = 0; i < TOUCH_MUESTRAS; i++) {
    if (!ts.touched()) {
      return false; // se levantó el dedo/lápiz a mitad de la lectura
    }

    TS_Point p = ts.getPoint();

    if (p.z < TOUCH_MIN_Z) {
      return false;
    }

    xs[i] = p.x;
    ys[i] = p.y;

    delay(4);
  }

  int minX = xs[0], maxX = xs[0];
  int minY = ys[0], maxY = ys[0];

  for (int i = 1; i < TOUCH_MUESTRAS; i++) {
    minX = min(minX, xs[i]);
    maxX = max(maxX, xs[i]);
    minY = min(minY, ys[i]);
    maxY = max(maxY, ys[i]);
  }

  if (
    (maxX - minX) > TOUCH_TOLERANCIA_RAW ||
    (maxY - minY) > TOUCH_TOLERANCIA_RAW
  ) {
    return false; // las muestras no coinciden entre sí: ruido, se descarta
  }

  long sumX = 0, sumY = 0;

  for (int i = 0; i < TOUCH_MUESTRAS; i++) {
    sumX += xs[i];
    sumY += ys[i];
  }

  int rawX = sumX / TOUCH_MUESTRAS;
  int rawY = sumY / TOUCH_MUESTRAS;

  rawXOut = TOUCH_SWAP_XY ? rawY : rawX;
  rawYOut = TOUCH_SWAP_XY ? rawX : rawY;

  while (ts.touched()) {
    delay(10);
  }

  return true;
}

// Versión "sin calibrar": devuelve el RAW estable (ya con TOUCH_SWAP_XY
// aplicado) sin mapear a pantalla. La usa SOLO calibrarTouchPorPantalla(),
// que es justamente la que todavía no tiene calibración para mapear nada.
bool leerToqueRaw(int &rawX, int &rawY) {
  return leerToqueEstable(rawX, rawY);
}

bool leerTouch(
  int &screenX,
  int &screenY
) {
  int rawX, rawY;

  if (!leerToqueEstable(rawX, rawY)) {
    return false;
  }

  // Ver el bloque CALIBRACIÓN TOUCH (arriba, junto a TOUCH_MIN_Z): mapeo
  // por 2 puntos medidos en el dispositivo, no por constantes adivinadas.
  // map() con touchCalX0 > touchCalX1 (o Y0 > Y1) invierte solo, así que
  // no hace falta ningún flag extra de inversión.
  screenX = map(
    rawX,
    touchCalX0,
    touchCalX1,
    CAL_TL_X,
    CAL_BR_X
  );

  screenY = map(
    rawY,
    touchCalY0,
    touchCalY1,
    CAL_TL_Y,
    CAL_BR_Y
  );

  screenX = constrain(
    screenX,
    0,
    SCREEN_W - 1
  );

  screenY = constrain(
    screenY,
    0,
    SCREEN_H - 1
  );

  Serial.print("Touch RAW X=");
  Serial.print(rawX);

  Serial.print(" Y=");
  Serial.print(rawY);

  Serial.print(" -> SCREEN X=");
  Serial.print(screenX);

  Serial.print(" Y=");
  Serial.println(screenY);

  return true;
}

// =====================================================
// BOTÓN
// =====================================================

bool botonInicioPresionado() {
  int x;
  int y;

  // NOTA: acá solo se llama con estado == ESPERANDO_INICIO, así que no
  // hace falta acertarle al rectángulo del botón: cualquier toque válido
  // en la pantalla (ya filtrado por presión mínima en leerTouch) inicia
  // la carga. Esto evita depender de que el mapeo raw->pantalla del
  // XPT2046 esté calibrado pixel a pixel (que es frágil y varía de
  // módulo a módulo); x/y solo quedan para loguear en Serial.
  if (
    !leerTouch(
      x,
      y
    )
  ) {
    return false;
  }

  Serial.println(
    "BOTON INICIAR CARGA (toda la pantalla es táctil en esta vista)"
  );

  // Feedback táctil
  tft.fillRoundRect(
    BTN_X,
    BTN_Y,
    BTN_W,
    BTN_H,
    14,
    COLOR_GREEN_DARK
  );

  tituloCentradoEnCaja(
    "INICIAR CARGA",
    BTN_X + 75,
    BTN_Y,
    BTN_W - 75 - 10,
    BTN_H,
    FONT_TITLE,
    ILI9341_WHITE
  );

  delay(120);

  while (
    ts.touched()
  ) {
    delay(10);
  }

  return true;
}

// =====================================================
// INICIAR CARGA
// =====================================================

void iniciarCarga() {
  digitalWrite(
    RELAY_PIN,
    RELAY_ON
  );

  inicioCargaMs =
    millis();

  inicioSinCorrienteMs =
    0;

  ultimoEnvioMedicionMs =
    0;

  ultimoRefrescoPantallaMs =
    0;

  ultimoCalculoEnergiaMs =
    millis();

  energiaWhSesion =
    0.0;

  pantallaCargaDibujada =
    false;

  enviarEstadoDispositivo(
    "cargando",
    tarjetaActualUid
  );

  estado =
    CARGANDO;

  tft.fillScreen(
    COLOR_BG
  );

  dibujarRayo(
    145,
    65,
    COLOR_GREEN
  );

  tituloCentrado(
    "Iniciando carga",
    135,
    FONT_TITLE,
    COLOR_TEXT
  );

  textoCentrado(
    "Preparando conexion...",
    168,
    1,
    COLOR_MUTED
  );

  delay(650);

  pantallaCargaBase();
}

// =====================================================
// FINALIZAR CARGA
// =====================================================

void finalizarCarga() {
  digitalWrite(
    RELAY_PIN,
    RELAY_OFF
  );

  enviarEstadoDispositivo(
    "finalizada",
    tarjetaActualUid
  );

  pantallaFinalizada();

  delay(3000);

  estado =
    ESPERANDO_TARJETA;

  inicioSinCorrienteMs =
    0;

  tarjetaActualUid =
    "";

  // El backend ya borró la solicitud (ver POST device-state "finalizada"),
  // así que el próximo cliente arranca sin ver el nombre del anterior.
  nombreClienteActual =
    "";

  ultimaConsultaSolicitudMs =
    0;

  pantallaEsperando();

  enviarEstadoDispositivo(
    "esperando_tarjeta",
    ""
  );
}

// =====================================================
// SETUP
// =====================================================

void setup() {
  Serial.begin(115200);

  delay(1000);

  pinMode(
    RELAY_PIN,
    OUTPUT
  );

  digitalWrite(
    RELAY_PIN,
    RELAY_OFF
  );

  // TFT + touch van primero, antes de WiFi: la pantalla muestra la guía
  // del portal de configuración sin depender de que ya exista una red.
  SPI.begin(
    18,
    19,
    23
  );

  pinMode(
    TFT_CS,
    OUTPUT
  );

  pinMode(
    TOUCH_CS,
    OUTPUT
  );

  digitalWrite(
    TFT_CS,
    HIGH
  );

  digitalWrite(
    TOUCH_CS,
    HIGH
  );

  tft.begin();
  tft.setRotation(1);

  ts.begin();
  ts.setRotation(1);

  // El onboarding se hace desde el navegador del celular. La TFT solo
  // muestra instrucciones, así que no depende de calibrar ni de acertar
  // teclas o filas con el panel resistivo.
  chargerId = cargarChargerIdGuardado();
  wifiSsid = cargarWifiSsidGuardado();
  wifiPassword = cargarWifiPasswordGuardado();

  bool forzarReconfiguracion = reconfiguracionSolicitadaAlArrancar();

  if (forzarReconfiguracion || wifiSsid.length() == 0 || chargerId.length() == 0) {
    ejecutarOnboardingDesdeCelular();
  }

  conectarWiFi();

  // Credenciales viejas o mal escritas ya no dejan la estación atrapada
  // offline: vuelve automáticamente al portal y permite corregirlas.
  if (WiFi.status() != WL_CONNECTED) {
    ejecutarOnboardingDesdeCelular();
    conectarWiFi();
  }

  Wire.begin(
    SDA_PIN,
    SCL_PIN
  );

  ina219.begin();

  Serial2.begin(
    115200,
    SERIAL_8N1,
    16,
    17
  );

  nfc.begin();

  uint32_t versiondata =
    nfc.getFirmwareVersion();

  if (!versiondata) {
    tft.fillScreen(
      COLOR_BG
    );

    tituloCentrado(
      "ERROR NFC",
      100,
      FONT_TITLE,
      ILI9341_RED
    );

    while (1) {
      delay(1000);
    }
  }

  nfc.SAMConfig();

  // Subir la ganancia del receptor (RxGain) al máximo: es el ajuste
  // estándar para estirar el alcance de lectura de un PN532 sin tocar
  // antena. Registro interno CIU_RFCfg (0x6303), bits 6:4 = RxGain;
  // 0x70 = 111b = 48 dB (máximo; el reset de fábrica trae ~33 dB).
  // El límite real lo sigue poniendo el tamaño/diseño de la antena: esto
  // exprime lo que da el hardware, no lo reemplaza.
  nfc.writeRegister(0x6303, 0x70);

  estado =
    ESPERANDO_TARJETA;

  pantallaEsperando();

  enviarEstadoDispositivo(
    "esperando_tarjeta",
    ""
  );
}

// =====================================================
// LOOP
// =====================================================

void loop() {
  asegurarWiFi();

  heartbeat();

  // ===================================================
  // ESPERANDO TARJETA
  // ===================================================

  if (
    estado ==
    ESPERANDO_TARJETA
  ) {
    // La lectura NFC va SIEMPRE primero y sin nada por delante: el poll al
    // backend es una llamada de red (puede demorar) y si corriera antes,
    // justo el ciclo en que alguien apoya la tarjeta podría perderse
    // esperando la respuesta HTTP en vez de escuchar al lector.
    uint8_t uid[7];
    uint8_t uidLength;

    bool success =
      nfc.readPassiveTargetID(
        PN532_MIFARE_ISO14443A,
        uid,
        &uidLength,
        200
      );

    if (success) {
      // Feedback instantáneo: la consulta de abajo es de red y puede
      // tardar, no queremos que la pantalla parezca colgada mientras tanto.
      pantallaValidando();

      // Solo dejamos avanzar si alguien pidió cargar desde la app. Acá
      // consultamos fresco (no el nombreClienteActual del poll periódico,
      // que puede tener hasta INTERVALO_CONSULTA_SOLICITUD_MS de atraso)
      // para no rebotar a alguien que pidió la carga segundos antes de
      // llegar a apoyar la tarjeta.
      nombreClienteActual =
        obtenerNombreSolicitudPendiente();

      if (nombreClienteActual.length() == 0) {
        pantallaTarjetaSinSolicitud();

        delay(1800);

        pantallaEsperando();
      } else {
        tarjetaActualUid =
          uidToHex(
            uid,
            uidLength
          );

        digitalWrite(
          RELAY_PIN,
          RELAY_OFF
        );

        estado =
          ESPERANDO_INICIO;

        pantallaIniciar();

        enviarEstadoDispositivo(
          "esperando_inicio",
          tarjetaActualUid
        );

        delay(500);
      }
    } else {
      // No hay tarjeta en este ciclo: recién acá vale la pena preguntarle
      // al backend si alguien pidió cargar desde la app, para saludarlo
      // por nombre. Cada pocos segundos nomás, no en cada vuelta del loop.
      if (
        millis() -
        ultimaConsultaSolicitudMs >=
        INTERVALO_CONSULTA_SOLICITUD_MS
      ) {
        ultimaConsultaSolicitudMs =
          millis();

        String nombre =
          obtenerNombreSolicitudPendiente();

        if (
          nombre !=
          nombreClienteActual
        ) {
          nombreClienteActual =
            nombre;

          pantallaEsperando();
        }
      }
    }
  }

  // ===================================================
  // ESPERANDO BOTÓN
  // ===================================================

  else if (
    estado ==
    ESPERANDO_INICIO
  ) {
    digitalWrite(
      RELAY_PIN,
      RELAY_OFF
    );

    if (
      botonInicioPresionado()
    ) {
      iniciarCarga();
    }
  }

  // ===================================================
  // CARGANDO
  // ===================================================

  else if (
    estado ==
    CARGANDO
  ) {
    float voltaje =
      ina219.getBusVoltage_V();

    float shuntMv =
      ina219.getShuntVoltage_mV();

    float corrienteMa =
      ina219.getCurrent_mA();

    float potenciaMw =
      ina219.getPower_mW();

    float corrienteA =
      corrienteMa /
      1000.0;

    float potenciaW =
      potenciaMw /
      1000.0;

    float fuenteV =
      voltaje +
      (
        shuntMv /
        1000.0
      );

    // -----------------------------------------------
    // ENERGÍA
    // -----------------------------------------------

    unsigned long ahora =
      millis();

    if (
      ultimoCalculoEnergiaMs !=
      0
    ) {
      float horas =
        (
          ahora -
          ultimoCalculoEnergiaMs
        ) /
        3600000.0;

      if (
        potenciaW > 0
      ) {
        energiaWhSesion +=
          potenciaW *
          horas;
      }
    }

    ultimoCalculoEnergiaMs =
      ahora;

    // -----------------------------------------------
    // UI
    // -----------------------------------------------

    if (
      millis() -
      ultimoRefrescoPantallaMs >=
      INTERVALO_REFRESCO_PANTALLA_MS
    ) {
      ultimoRefrescoPantallaMs =
        millis();

      actualizarDatosCarga(
        voltaje,
        corrienteA,
        potenciaW
      );
    }

    // -----------------------------------------------
    // BACKEND
    // -----------------------------------------------

    if (
      millis() -
      ultimoEnvioMedicionMs >=
      INTERVALO_ENVIO_MEDICION_MS
    ) {
      ultimoEnvioMedicionMs =
        millis();

      enviarMedicion(
        fuenteV,
        voltaje,
        shuntMv,
        corrienteMa,
        potenciaMw
      );
    }

    // -----------------------------------------------
    // DETECTAR DESCONEXIÓN
    // -----------------------------------------------

    if (
      millis() -
      inicioCargaMs >
      GRACIA_INICIAL_MS
    ) {
      if (
        corrienteA <
        UMBRAL_CORRIENTE_A
      ) {
        if (
          inicioSinCorrienteMs ==
          0
        ) {
          inicioSinCorrienteMs =
            millis();
        }

        if (
          millis() -
          inicioSinCorrienteMs >=
          TIEMPO_SIN_CARGA_MS
        ) {
          finalizarCarga();
        }

      } else {
        inicioSinCorrienteMs =
          0;
      }
    }

    delay(20);
  }
}
