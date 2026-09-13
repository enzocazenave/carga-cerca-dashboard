#include <Wire.h>
#include <SPI.h>

#include <Adafruit_INA219.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

#include <PN532_HSU.h>
#include <PN532.h>

#include <XPT2046_Touchscreen.h>

// INTEGRACIÓN BACKEND: WiFi + HTTP para hablar con CargaCerca
#include <WiFi.h>
#include <HTTPClient.h>

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

// Valores típicos iniciales del XPT2046.
// Nos sirven perfectamente para prototipo.
// Si después queremos precisión milimétrica, calibramos.
#define TS_MIN 200
#define TS_MAX 3900

#define SCREEN_W 320
#define SCREEN_H 240

// Presión mínima para ignorar ruido
#define TOUCH_MIN_Z 150

// =====================================================
// RELAY
// =====================================================

#define RELAY_PIN 26

#define RELAY_ON  LOW
#define RELAY_OFF HIGH

// =====================================================
// INTEGRACIÓN BACKEND - CargaCerca
// =====================================================
//
// Este cargador reporta al backend cada transición de estado
// (esperando_tarjeta / esperando_inicio / cargando / finalizada) y,
// mientras está CARGANDO, las mediciones del INA219 cada pocos segundos.
//
// El cargador (CHARGER_ID) tiene que existir de antes en el panel:
// https://TU-DOMINIO.up.railway.app -> "+ Agregar cargador".

const char* WIFI_SSID     = "TU_WIFI";
const char* WIFI_PASSWORD = "TU_PASSWORD";

// Reemplazar por tu dominio de Railway (sin "/" al final):
const char* API_BASE_URL = "https://MI-PROYECTO.up.railway.app";
const char* CHARGER_ID   = "CC-001";

// Cada cuánto se manda una medición mientras se está cargando.
const unsigned long INTERVALO_ENVIO_MEDICION_MS = 2000;
unsigned long ultimoEnvioMedicionMs = 0;

// Throttle para no intentar reconectar WiFi en cada vuelta del loop.
const unsigned long INTERVALO_REINTENTO_WIFI_MS = 5000;
unsigned long ultimoIntentoWifiMs = 0;

// UID (en hex) de la tarjeta/llavero que abrió la sesión actual.
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
// CONTROL DE CARGA
// =====================================================

const float UMBRAL_CORRIENTE_A = 0.05;

const unsigned long GRACIA_INICIAL_MS = 10000;
const unsigned long TIEMPO_SIN_CARGA_MS = 3000;

unsigned long inicioCargaMs = 0;
unsigned long inicioSinCorrienteMs = 0;

// =====================================================
// BOTÓN
// =====================================================

const int BTN_X = 35;
const int BTN_Y = 125;
const int BTN_W = 250;
const int BTN_H = 65;

// Margen táctil adicional.
// Visualmente el botón no cambia,
// pero es más fácil tocarlo con el dedo.
const int BTN_TOUCH_MARGIN = 20;

// =====================================================
// FUNCIONES DE PANTALLA
// =====================================================

void pantallaEsperando() {

  tft.fillScreen(ILI9341_BLACK);

  tft.setTextColor(ILI9341_WHITE);
  tft.setTextSize(3);
  tft.setCursor(35, 40);
  tft.println("CargaCerca");

  tft.setTextSize(2);
  tft.setCursor(45, 110);
  tft.println("Acerca tu tarjeta");

  tft.setTextSize(1);
  tft.setTextColor(ILI9341_CYAN);
  tft.setCursor(90, 205);
  tft.println("Cargador bloqueado");
}

// -----------------------------------------------------

void pantallaIniciar() {

  tft.fillScreen(ILI9341_BLACK);

  tft.setTextColor(ILI9341_GREEN);
  tft.setTextSize(3);
  tft.setCursor(35, 30);
  tft.println("Tarjeta OK");

  tft.setTextColor(ILI9341_WHITE);
  tft.setTextSize(2);
  tft.setCursor(60, 85);
  tft.println("Listo para cargar");

  // Botón
  tft.fillRoundRect(
    BTN_X,
    BTN_Y,
    BTN_W,
    BTN_H,
    12,
    ILI9341_GREEN
  );

  tft.drawRoundRect(
    BTN_X,
    BTN_Y,
    BTN_W,
    BTN_H,
    12,
    ILI9341_WHITE
  );

  tft.setTextColor(ILI9341_BLACK);
  tft.setTextSize(2);
  tft.setCursor(75, 150);
  tft.print("INICIAR CARGA");
}

// -----------------------------------------------------

void pantallaCarga(
  float voltaje,
  float corrienteA,
  float potenciaW
) {

  tft.fillScreen(ILI9341_BLACK);

  tft.setTextColor(ILI9341_GREEN);
  tft.setTextSize(3);
  tft.setCursor(65, 20);
  tft.println("Cargando");

  tft.setTextColor(ILI9341_WHITE);
  tft.setTextSize(2);

  tft.setCursor(30, 80);
  tft.print("Voltaje:   ");
  tft.print(voltaje, 2);
  tft.println(" V");

  tft.setCursor(30, 120);
  tft.print("Corriente: ");
  tft.print(corrienteA, 3);
  tft.println(" A");

  tft.setCursor(30, 160);
  tft.print("Potencia:  ");
  tft.print(potenciaW, 2);
  tft.println(" W");

  tft.setTextSize(1);
  tft.setTextColor(ILI9341_CYAN);
  tft.setCursor(65, 215);
  tft.println("Desconecta para finalizar");
}

// -----------------------------------------------------

void pantallaFinalizada() {

  tft.fillScreen(ILI9341_BLACK);

  tft.setTextColor(ILI9341_YELLOW);
  tft.setTextSize(3);

  tft.setCursor(65, 70);
  tft.println("Carga");

  tft.setCursor(40, 115);
  tft.println("finalizada");
}

// =====================================================
// INTEGRACIÓN BACKEND - WiFi
// =====================================================

void conectarWiFi() {

  Serial.print("Conectando a WiFi");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long inicio = millis();

  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - inicio < 15000
  ) {
    delay(300);
    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi conectado. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi: no se pudo conectar. Se reintenta solo en el loop.");
  }
}

// Reintento no bloqueante: se llama en cada vuelta del loop pero
// solo actúa cada INTERVALO_REINTENTO_WIFI_MS para no trabar la UI.
void asegurarWiFi() {

  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  if (millis() - ultimoIntentoWifiMs < INTERVALO_REINTENTO_WIFI_MS) {
    return;
  }

  ultimoIntentoWifiMs = millis();

  Serial.println("WiFi desconectado. Reintentando...");
  WiFi.reconnect();
}

// =====================================================
// INTEGRACIÓN BACKEND - HTTP
// =====================================================

String uidToHex(uint8_t *uid, uint8_t len) {

  String out = "";

  for (uint8_t i = 0; i < len; i++) {
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

// -----------------------------------------------------
// POST /api/chargers/:chargerId/device-state
//
// estado: "esperando_tarjeta" | "esperando_inicio" | "cargando" | "finalizada"
// cardUid: UID de la tarjeta ("" si no aplica)
// -----------------------------------------------------

void enviarEstadoDispositivo(const char* estadoTexto, const String &cardUid) {

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[backend] Sin WiFi, no se pudo enviar el estado");
    return;
  }

  String url =
    String(API_BASE_URL) +
    "/api/chargers/" +
    CHARGER_ID +
    "/device-state";

  String json = "{\"state\":\"" + String(estadoTexto) + "\"";

  if (cardUid.length() > 0) {
    json += ",\"cardUid\":\"" + cardUid + "\"";
  }

  json += "}";

  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(4000);

  int code = http.POST(json);

  if (code == 201) {
    Serial.print("[backend] Estado enviado: ");
    Serial.println(estadoTexto);
  } else if (code > 0) {
    Serial.print("[backend] Estado rechazado (HTTP ");
    Serial.print(code);
    Serial.print("): ");
    Serial.println(http.getString());
  } else {
    Serial.print("[backend] Error de red enviando estado: ");
    Serial.println(http.errorToString(code));
  }

  http.end();
}

// -----------------------------------------------------
// POST /api/measurements
// -----------------------------------------------------

void enviarMedicion(
  float sourceVoltage,
  float busVoltage,
  float shuntVoltageMv,
  float currentMa,
  float powerMw
) {

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[backend] Sin WiFi, no se pudo enviar la medición");
    return;
  }

  String url = String(API_BASE_URL) + "/api/measurements";

  String json = "{";
  json += "\"chargerId\":\"" + String(CHARGER_ID) + "\",";
  json += "\"sourceVoltage\":" + String(sourceVoltage, 2) + ",";
  json += "\"busVoltage\":" + String(busVoltage, 2) + ",";
  json += "\"shuntVoltageMv\":" + String(shuntVoltageMv, 2) + ",";
  json += "\"currentMa\":" + String(currentMa, 2) + ",";
  json += "\"powerMw\":" + String(powerMw, 2);
  json += "}";

  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(4000);

  int code = http.POST(json);

  if (code == 201) {
    Serial.println("[backend] Datos enviados. HTTP 201");
  } else if (code > 0) {
    Serial.print("[backend] Medición rechazada (HTTP ");
    Serial.print(code);
    Serial.print("): ");
    Serial.println(http.getString());
  } else {
    Serial.print("[backend] Error de red enviando medición: ");
    Serial.println(http.errorToString(code));
  }

  http.end();
}

// =====================================================
// TOUCH
// =====================================================

bool leerTouch(int &screenX, int &screenY) {

  // Aseguramos que la TFT no esté seleccionada
  // mientras hablamos con el controlador touch.
  digitalWrite(TFT_CS, HIGH);

  if (!ts.touched()) {
    return false;
  }

  TS_Point p = ts.getPoint();

  if (p.z < TOUCH_MIN_Z) {
    return false;
  }

  /*
    IMPORTANTE:

    En este módulo, con la TFT rotada en landscape,
    normalmente los ejes del touch quedan:

      raw Y -> pantalla X
      raw X -> pantalla Y

    y uno de ellos invertido.

    Eso es lo que estaba causando que tocaras el botón
    visualmente pero el software creyera que tocabas otro lugar.
  */

  screenX = map(
    p.y,
    TS_MIN,
    TS_MAX,
    0,
    SCREEN_W
  );

  screenY = map(
    p.x,
    TS_MAX,
    TS_MIN,
    0,
    SCREEN_H
  );

  screenX = constrain(screenX, 0, SCREEN_W - 1);
  screenY = constrain(screenY, 0, SCREEN_H - 1);

  Serial.print("TOUCH raw(");
  Serial.print(p.x);
  Serial.print(",");
  Serial.print(p.y);

  Serial.print(") -> screen(");
  Serial.print(screenX);
  Serial.print(",");
  Serial.print(screenY);
  Serial.println(")");

  return true;
}

// -----------------------------------------------------

bool botonInicioPresionado() {

  int x;
  int y;

  if (!leerTouch(x, y)) {
    return false;
  }

  int izquierda = BTN_X - BTN_TOUCH_MARGIN;
  int derecha   = BTN_X + BTN_W + BTN_TOUCH_MARGIN;

  int arriba = BTN_Y - BTN_TOUCH_MARGIN;
  int abajo  = BTN_Y + BTN_H + BTN_TOUCH_MARGIN;

  bool dentro =
    x >= izquierda &&
    x <= derecha &&
    y >= arriba &&
    y <= abajo;

  if (!dentro) {
    return false;
  }

  Serial.println(">>> BOTON INICIAR CARGA <<<");

  // Feedback visual inmediato
  tft.fillRoundRect(
    BTN_X,
    BTN_Y,
    BTN_W,
    BTN_H,
    12,
    ILI9341_DARKGREEN
  );

  tft.setTextColor(ILI9341_WHITE);
  tft.setTextSize(2);
  tft.setCursor(75, 150);
  tft.print("INICIAR CARGA");

  // Esperamos a que el usuario retire el dedo.
  delay(150);

  while (ts.touched()) {
    delay(10);
  }

  delay(100);

  return true;
}

// =====================================================
// INICIAR CARGA
// =====================================================

void iniciarCarga() {

  Serial.println("RELAY ON - CARGA INICIADA");

  digitalWrite(RELAY_PIN, RELAY_ON);

  inicioCargaMs = millis();
  inicioSinCorrienteMs = 0;

  // Forzamos que la primera medición se mande apenas haya datos,
  // sin esperar el intervalo completo.
  ultimoEnvioMedicionMs = 0;

  enviarEstadoDispositivo("cargando", tarjetaActualUid);

  estado = CARGANDO;

  tft.fillScreen(ILI9341_BLACK);

  tft.setTextColor(ILI9341_GREEN);
  tft.setTextSize(3);
  tft.setCursor(50, 90);
  tft.println("Iniciando...");

  delay(700);
}

// =====================================================
// FINALIZAR CARGA
// =====================================================

void finalizarCarga() {

  Serial.println("RELAY OFF - CARGA FINALIZADA");

  digitalWrite(RELAY_PIN, RELAY_OFF);

  enviarEstadoDispositivo("finalizada", tarjetaActualUid);

  pantallaFinalizada();

  delay(2500);

  estado = ESPERANDO_TARJETA;

  inicioSinCorrienteMs = 0;
  tarjetaActualUid = "";

  pantallaEsperando();

  enviarEstadoDispositivo("esperando_tarjeta", "");
}

// =====================================================
// SETUP
// =====================================================

void setup() {

  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("=======================");
  Serial.println("      CARGACERCA");
  Serial.println("=======================");

  // ---------------------------------------------------
  // RELAY
  // ---------------------------------------------------

  pinMode(RELAY_PIN, OUTPUT);

  // Seguridad:
  // siempre apagado al arrancar.
  digitalWrite(RELAY_PIN, RELAY_OFF);

  // ---------------------------------------------------
  // WiFi (backend)
  // ---------------------------------------------------

  conectarWiFi();

  // ---------------------------------------------------
  // I2C
  // ---------------------------------------------------

  Wire.begin(SDA_PIN, SCL_PIN);

  if (ina219.begin()) {
    Serial.println("INA219: OK");
  } else {
    Serial.println("INA219: ERROR");
  }

  // ---------------------------------------------------
  // SPI
  // ---------------------------------------------------

  SPI.begin(
    18, // SCK
    19, // MISO
    23  // MOSI
  );

  pinMode(TFT_CS, OUTPUT);
  pinMode(TOUCH_CS, OUTPUT);

  digitalWrite(TFT_CS, HIGH);
  digitalWrite(TOUCH_CS, HIGH);

  // ---------------------------------------------------
  // TFT
  // ---------------------------------------------------

  tft.begin();
  tft.setRotation(1);

  Serial.println("TFT: OK");

  // ---------------------------------------------------
  // TOUCH
  // ---------------------------------------------------

  ts.begin();
  ts.setRotation(1);

  Serial.println("Touch: OK");

  // ---------------------------------------------------
  // PN532
  // ---------------------------------------------------

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

    Serial.println("PN532: ERROR");

    tft.fillScreen(ILI9341_BLACK);

    tft.setTextColor(ILI9341_RED);
    tft.setTextSize(2);

    tft.setCursor(50, 100);
    tft.println("PN532 ERROR");

    while (1) {
      delay(1000);
    }
  }

  nfc.SAMConfig();

  Serial.println("PN532: OK");

  // ---------------------------------------------------

  estado = ESPERANDO_TARJETA;

  pantallaEsperando();

  enviarEstadoDispositivo("esperando_tarjeta", "");

  Serial.println("Sistema listo");
}

// =====================================================
// LOOP
// =====================================================

void loop() {

  // Reintento de WiFi no bloqueante (no afecta NFC/touch/relay).
  asegurarWiFi();

  // ===================================================
  // ESPERANDO TARJETA
  // ===================================================

  if (estado == ESPERANDO_TARJETA) {

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

      tarjetaActualUid = uidToHex(uid, uidLength);

      Serial.print("Tarjeta detectada UID: ");
      Serial.println(tarjetaActualUid);

      // Seguimos bloqueados.
      digitalWrite(
        RELAY_PIN,
        RELAY_OFF
      );

      estado =
        ESPERANDO_INICIO;

      pantallaIniciar();

      // Guarda el "método de pago" (por ahora, el UID crudo de la
      // tarjeta) y avisa al panel que hay que esperar que el usuario
      // presione "Iniciar carga" en la pantalla física.
      enviarEstadoDispositivo("esperando_inicio", tarjetaActualUid);

      // Evita releer la misma tarjeta inmediatamente.
      delay(500);
    }
  }

  // ===================================================
  // ESPERANDO QUE TOQUES "INICIAR CARGA"
  // ===================================================

  else if (
    estado ==
    ESPERANDO_INICIO
  ) {

    // Seguimos garantizando que no pase corriente.
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

    float corrienteA = corrienteMa / 1000.0;
    float potenciaW  = potenciaMw / 1000.0;
    float fuenteV    = voltaje + (shuntMv / 1000.0);

    Serial.print("V=");
    Serial.print(voltaje, 2);

    Serial.print(" A=");
    Serial.print(corrienteA, 3);

    Serial.print(" W=");
    Serial.println(potenciaW, 2);

    pantallaCarga(
      voltaje,
      corrienteA,
      potenciaW
    );

    // -----------------------------------------------
    // Reportar medición al backend (cada pocos segundos,
    // no en cada vuelta del loop).
    // -----------------------------------------------

    if (
      millis() - ultimoEnvioMedicionMs >=
      INTERVALO_ENVIO_MEDICION_MS
    ) {

      ultimoEnvioMedicionMs = millis();

      enviarMedicion(
        fuenteV,
        voltaje,
        shuntMv,
        corrienteMa,
        potenciaMw
      );
    }

    // -----------------------------------------------
    // Detectar desconexión
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
          inicioSinCorrienteMs == 0
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
      }

      else {

        // Hay consumo:
        // cancelamos posible detección de desconexión.
        inicioSinCorrienteMs = 0;
      }
    }

    delay(250);
  }
}
