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

#define TS_MIN 200
#define TS_MAX 3900

#define SCREEN_W 320
#define SCREEN_H 240

#define TOUCH_MIN_Z 150

// =====================================================
// RELAY
// =====================================================

#define RELAY_PIN 26

#define RELAY_ON  LOW
#define RELAY_OFF HIGH

// =====================================================
// BACKEND
// =====================================================

const char* WIFI_SSID = "TU_WIFI";
const char* WIFI_PASSWORD = "TU_PASSWORD_WIFI";

const char* API_BASE_URL =
  "https://carga-cerca-dashboard-production.up.railway.app";

const char* CHARGER_ID = "CC-001";

const unsigned long INTERVALO_ENVIO_MEDICION_MS = 2000;
unsigned long ultimoEnvioMedicionMs = 0;

const unsigned long INTERVALO_REINTENTO_WIFI_MS = 5000;
unsigned long ultimoIntentoWifiMs = 0;

String tarjetaActualUid = "";

// =====================================================
// ESTADOS
// =====================================================

enum Estado {
  ESPERANDO_TARJETA,
  ESPERANDO_INICIO,
  CARGANDO
};

Estado estado = ESPERANDO_TARJETA;

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

void textoCentrado(
  const String &texto,
  int y,
  int size,
  uint16_t color
) {
  tft.setTextSize(size);
  tft.setTextColor(color);

  int ancho = texto.length() * 6 * size;
  int x = (SCREEN_W - ancho) / 2;

  if (x < 0) x = 0;

  tft.setCursor(x, y);
  tft.print(texto);
}

// -----------------------------------------------------

void dibujarHeader(
  const char* estadoTexto,
  uint16_t colorEstado
) {
  tft.setTextColor(COLOR_TEXT);
  tft.setTextSize(2);
  tft.setCursor(15, 13);
  tft.print("CargaCerca");

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

  dibujarIconoNFC(
    160,
    105,
    COLOR_GREEN
  );

  textoCentrado(
    "Acerca tu tarjeta",
    148,
    2,
    COLOR_TEXT
  );

  textoCentrado(
    "para comenzar",
    171,
    1,
    COLOR_MUTED
  );

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
  tft.print("Cargador disponible");
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

  textoCentrado(
    "Tarjeta detectada",
    109,
    2,
    COLOR_TEXT
  );

  textoCentrado(
    "Podes iniciar la carga",
    132,
    1,
    COLOR_MUTED
  );

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

  tft.setTextColor(COLOR_BG);
  tft.setTextSize(2);
  tft.setCursor(
    BTN_X + 85,
    BTN_Y + 21
  );

  tft.print("INICIAR CARGA");
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

  // Potencia
  tft.fillRect(
    27,
    87,
    265,
    40,
    COLOR_CARD
  );

  String potenciaTexto =
    String(potenciaW, 2);

  int potenciaX =
    135 -
    (potenciaTexto.length() * 9);

  tft.setTextColor(COLOR_TEXT);
  tft.setTextSize(4);
  tft.setCursor(potenciaX, 92);

  tft.print(potenciaTexto);

  tft.setTextSize(2);
  tft.setTextColor(COLOR_GREEN);
  tft.print(" W");

  // Voltaje
  tft.fillRect(
    23,
    175,
    77,
    22,
    COLOR_CARD
  );

  tft.setTextColor(COLOR_TEXT);
  tft.setTextSize(2);
  tft.setCursor(26, 177);

  tft.print(
    voltaje,
    2
  );

  tft.setTextSize(1);
  tft.print(" V");

  // Corriente
  tft.fillRect(
    120,
    175,
    80,
    22,
    COLOR_CARD
  );

  tft.setTextColor(COLOR_TEXT);
  tft.setTextSize(2);
  tft.setCursor(122, 177);

  tft.print(
    corrienteA,
    2
  );

  tft.setTextSize(1);
  tft.print(" A");

  // Energía
  tft.fillRect(
    220,
    175,
    77,
    22,
    COLOR_CARD
  );

  tft.setTextColor(COLOR_TEXT);
  tft.setTextSize(2);
  tft.setCursor(221, 177);

  tft.print(
    energiaWhSesion,
    2
  );

  tft.setTextSize(1);
  tft.print(" Wh");
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

  textoCentrado(
    "Carga finalizada",
    147,
    2,
    COLOR_TEXT
  );

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

  textoCentrado(
    "Gracias por usar CargaCerca",
    211,
    1,
    COLOR_MUTED
  );
}

// =====================================================
// WIFI
// =====================================================

void conectarWiFi() {
  Serial.print("Conectando a WiFi");

  WiFi.mode(WIFI_STA);
  WiFi.begin(
    WIFI_SSID,
    WIFI_PASSWORD
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
    CHARGER_ID +
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
    String(CHARGER_ID) +
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
// TOUCH
// =====================================================

bool leerTouch(
  int &screenX,
  int &screenY
) {
  digitalWrite(
    TFT_CS,
    HIGH
  );

  if (!ts.touched()) {
    return false;
  }

  TS_Point p =
    ts.getPoint();

  if (
    p.z <
    TOUCH_MIN_Z
  ) {
    return false;
  }

  /*
    IMPORTANTE:
    ts.setRotation(1) ya rota el touch.

    Por eso hacemos mapping directo:
    p.x -> screenX
    p.y -> screenY
  */

  screenX = map(
    p.x,
    TS_MIN,
    TS_MAX,
    0,
    SCREEN_W
  );

  screenY = map(
    p.y,
    TS_MIN,
    TS_MAX,
    0,
    SCREEN_H
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
  Serial.print(p.x);

  Serial.print(" Y=");
  Serial.print(p.y);

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

  tft.setTextColor(
    ILI9341_WHITE
  );

  tft.setTextSize(2);

  tft.setCursor(
    BTN_X + 85,
    BTN_Y + 21
  );

  tft.print(
    "INICIAR CARGA"
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

  textoCentrado(
    "Iniciando carga",
    135,
    2,
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

  conectarWiFi();

  Wire.begin(
    SDA_PIN,
    SCL_PIN
  );

  ina219.begin();

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

    textoCentrado(
      "ERROR NFC",
      100,
      2,
      ILI9341_RED
    );

    while (1) {
      delay(1000);
    }
  }

  nfc.SAMConfig();

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

  // ===================================================
  // ESPERANDO TARJETA
  // ===================================================

  if (
    estado ==
    ESPERANDO_TARJETA
  ) {
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