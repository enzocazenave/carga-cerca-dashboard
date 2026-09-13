# CargaCerca — Panel + API del prototipo

Panel interno **temporal** y API para el prototipo de cargadores CargaCerca.

Recibe mediciones eléctricas enviadas por dispositivos **ESP32 + INA219**, las
guarda en SQLite y muestra un dashboard web simple para administrar cargadores y
ver sus datos casi en tiempo real.

> Es un prototipo para validar la idea. Más adelante se hará una app mobile real.

## Stack

- Node.js (>= 22.13) + Express
- SQLite nativo de Node (`node:sqlite`) — sin dependencias nativas que compilar
- HTML + CSS + JavaScript vanilla
- Chart.js vía CDN

Sin React, sin build, sin TypeScript, sin Docker, sin WebSockets, **sin autenticación**.

---

## Ejecución local

```bash
npm install
npm start
```

Abrir: <http://localhost:3000>

La base SQLite se crea sola en `./data/cargacerca.sqlite` la primera vez.

### Vistas

| Ruta                     | Para quién      | Qué muestra                                                        |
| ------------------------ | --------------- | ---------------------------------------------------------------- |
| `/`                      | Interno         | Panel de cargadores (alta / edición / borrado).                  |
| `/chargers/:chargerId`   | Interno/técnico | Detalle completo: todas las métricas + 3 gráficos.               |
| `/c/:chargerId`          | **Cliente**     | Vista mobile simple: estado, energía cargada (kWh y ≈ km), tiempo, costo estimado y un gráfico de potencia. Datos técnicos plegados. |

La vista cliente se abre desde el panel (botón **Vista cliente** en cada card) o
compartiendo el link directo `https://TU-DOMINIO.up.railway.app/c/CC-001`.

### Simulador (opcional, sin hardware)

Para ver el dashboard "moverse" sin un ESP32 real:

```bash
npm run simulate            # usa CC-001 contra http://localhost:3000
node simulate.js CC-002 http://localhost:3000
```

Crea el cargador si no existe y envía una medición cada 5 s alternando carga/reposo.

---

## Variables de entorno

| Variable         | Default                      | Descripción                                              |
| ---------------- | ---------------------------- | ------------------------------------------------------- |
| `PORT`           | `3000`                       | Puerto del servidor. En Railway se define solo.         |
| `DATABASE_PATH`  | `./data/cargacerca.sqlite`   | Ruta del archivo SQLite. En Railway apuntar a un Volume. |
| `PRICE_PER_KWH`  | `0`                          | Precio de la energía para la vista cliente. `0` oculta el costo. |
| `PRICE_CURRENCY` | `ARS`                        | Moneda del costo estimado.                              |
| `KM_PER_KWH`     | `6`                          | Autonomía aprox. por kWh para el "≈ X km cargados".     |

El servidor escucha en `0.0.0.0` y usa `process.env.PORT || 3000`. No hay
`localhost` hardcodeado en el backend.

Umbrales de estado y de sesión están centralizados en [`config.js`](config.js).

---

## Deploy en Railway

1. **Crear proyecto** en <https://railway.app> → *New Project*.
2. **Conectar el repositorio** (*Deploy from GitHub repo*).
3. Railway detecta Node y ejecuta automáticamente `npm install` y `npm start`
   (ver [`railway.json`](railway.json), que también define el healthcheck `/health`).
   El archivo [`.nvmrc`](.nvmrc) fija Node 22, necesario para `node:sqlite`.
   No hay dependencias nativas: `npm install` no compila nada.
4. **Configurar un Volume** si querés persistencia real de SQLite:
   - En el servicio → pestaña *Volumes* → *New Volume*.
   - Mount path: `/data`.
5. **Configurar `DATABASE_PATH`** en *Variables*:
   ```
   DATABASE_PATH=/data/cargacerca.sqlite
   ```
6. **Generar dominio público**: servicio → *Settings* → *Networking* → *Generate Domain*.
   Queda algo como `https://cargacerca-api.up.railway.app`.
7. **Usar ese dominio en el ESP32**:
   ```
   https://cargacerca-api.up.railway.app/api/measurements
   ```

### ⚠️ Persistencia en Railway

El filesystem de un deploy de Railway es **efímero**: en cada redeploy se pierde
lo que no esté en un Volume. Si no configurás un Volume + `DATABASE_PATH`
apuntando a él, **la base SQLite se reinicia** en cada deploy. Para el prototipo
puede alcanzar, pero para no perder datos hay que hacer los pasos 4 y 5.

---

## API

Base local: `http://localhost:3000`
Base Railway: `https://TU-PROYECTO.up.railway.app`

### Healthcheck

```
GET /health  ->  { "ok": true }
```

### Cargadores (CRUD)

| Método | Ruta                          | Descripción                          |
| ------ | ----------------------------- | ----------------------------------- |
| GET    | `/api/chargers`               | Lista con estado y sesión de c/u     |
| GET    | `/api/chargers/:chargerId`    | Un cargador + estado + sesión        |
| POST   | `/api/chargers`               | Crear                                |
| PUT    | `/api/chargers/:chargerId`    | Editar (nombre / ubicación / desc.)  |
| DELETE | `/api/chargers/:chargerId`    | Eliminar (borra también sus mediciones) |

**POST `/api/chargers`**

```json
{
  "chargerId": "CC-001",
  "name": "Cargador oficina",
  "location": "Berazategui",
  "description": "Prototipo"
}
```

Validaciones: `chargerId` obligatorio y único, `name` obligatorio.

### Mediciones

**POST `/api/measurements`** — lo que envía el ESP32.

```json
{
  "chargerId": "CC-001",
  "sourceVoltage": 5.29,
  "busVoltage": 5.14,
  "shuntVoltageMv": 148.56,
  "currentMa": 1485.50,
  "powerMw": 7642.00
}
```

- El cargador debe existir. Si no, responde `404` con un mensaje claro.
- Respuesta OK: `201` con `{ "ok": true }`.

| Método | Ruta                                              | Descripción                          |
| ------ | ------------------------------------------------- | ----------------------------------- |
| GET    | `/api/chargers/:chargerId/measurements?limit=100` | Últimas N mediciones (orden ascendente) |
| GET    | `/api/chargers/:chargerId/latest`                 | Última medición + estado + sesión    |

### Estado del dispositivo (cargadores con NFC + relé)

Para un cargador "kiosco" (pantalla + lector NFC + relé, ver
[`esp32/cargacerca_estacion`](esp32/cargacerca_estacion)), el firmware reporta
su propia máquina de estados. Es opcional: un ESP32 simple (solo INA219) nunca
llama a esto y el estado se sigue infiriendo por corriente, como antes.

**POST `/api/chargers/:chargerId/device-state`**

```json
{ "state": "esperando_inicio", "cardUid": "04:A3:B2:C1" }
```

- `state` debe ser uno de: `esperando_tarjeta`, `esperando_inicio`, `cargando`, `finalizada`.
- `cardUid` es opcional (UID crudo leído por el PN532, en hex).
- El cargador debe existir. Si no, `404`. Si `state` es inválido, `400`.
- Respuesta OK: `201` con `{ "ok": true }`.
- Se guarda como una sola fila "último estado" por cargador (no hay historial).

### Estado del cargador

Un cargador puede llegar a su estado por dos caminos (lógica centralizada en
[`status.js`](status.js) / [`config.js`](config.js)):

**1) Reportado por el dispositivo** (si mandó un `device-state` en los últimos 20 s):

| `state` reportado    | Estado mostrado                    |
| --------------------- | ----------------------------------- |
| `esperando_tarjeta`   | `Esperando tarjeta`                 |
| `esperando_inicio`    | `Tarjeta leída · esperando inicio`  |
| `cargando`            | `Cargando`                          |
| `finalizada`          | `Carga finalizada`                  |

**2) Inferido por corriente** (fallback, para un ESP32 simple sin NFC/relé, o si no mandó `device-state` reciente):

| Condición                                   | Estado            |
| ------------------------------------------- | ----------------- |
| Nunca recibió datos ni estado               | `Nunca conectado` |
| Última señal (medición o estado) > 20 s     | `Desconectado`    |
| `currentMa < 50`                            | `Disponible`      |
| `50 <= currentMa < 300`                     | `Consumo bajo`    |
| `currentMa >= 300`                          | `Cargando`        |

### Sesión actual

- Empieza cuando la corriente pasa de `< 50 mA` a `>= 50 mA`.
- Termina cuando se mantiene `< 50 mA` durante 10 s.
- La energía (`Wh`) se calcula integrando la potencia en el tiempo (trapecio).

---

## Estructura

```
package.json
railway.json
server.js          # Express: API + vistas
database.js        # abre SQLite con node:sqlite y crea tablas + índice si no existen
config.js          # puerto, ruta DB, umbrales de estado/sesión, precio kWh
status.js          # cálculo de estado y de sesión
simulate.js        # simulador de ESP32 (opcional)
public/
  index.html       # panel de cargadores
  charger.html     # detalle técnico de un cargador (cards + 3 gráficos)
  cliente.html     # vista cliente mobile (/c/:chargerId)
  list.js
  detail.js
  cliente.js
  styles.css
data/
  cargacerca.sqlite  # se crea sola
esp32/
  cargacerca_estacion/
    cargacerca_estacion.ino  # firmware "kiosco": INA219 + PN532 (NFC) + TFT + touch + relé
```

### Base de datos

- `chargers`: `id`, `charger_id` (único), `name`, `location`, `description`, `created_at`, `updated_at`.
- `measurements`: `id`, `charger_id` (FK → `chargers.charger_id`, `ON DELETE CASCADE`),
  `source_voltage`, `bus_voltage`, `shunt_voltage_mv`, `current_ma`, `power_mw`, `created_at`.
- `device_status`: `charger_id` (PK, FK → `chargers.charger_id`, `ON DELETE CASCADE`), `state`,
  `card_uid`, `updated_at`. Una sola fila por cargador (se pisa con el último estado reportado).
- Índice `(charger_id, created_at DESC)` para las consultas de mediciones recientes.

---

## 🔒 Seguridad — pendiente antes de producción

**Este prototipo NO tiene autenticación.** El panel web y la API quedan abiertos.

Antes de pasar a producción real hay que incorporar:

- Autenticación de **usuarios** para el panel.
- Autenticación de **dispositivos** (token/clave por ESP32) para `POST /api/measurements` y `POST /api/chargers/:chargerId/device-state`.
- Rate limiting y validación más estricta de payloads.
- `cardUid` hoy es solo el UID crudo que lee el PN532: **no hay alta de tarjetas válidas, ni verificación de titular, ni cobro real.** Cualquier tarjeta/llavero NFC destraba el cargador. Antes de cobrar de verdad hay que: registrar tarjetas autorizadas, validar el UID contra esa lista antes de permitir `iniciarCarga()`, y asociar cada sesión a un método de pago real.

No está implementado a propósito: es un panel interno temporal.

---

## Firmware "estación" (INA219 + NFC + relé + pantalla)

Si tu ESP32 tiene, además del INA219, un lector NFC (PN532), un relé y una
pantalla táctil (ILI9341 + XPT2046) para bloquear/destrabar el cargador con
una tarjeta, usá [`esp32/cargacerca_estacion/cargacerca_estacion.ino`](esp32/cargacerca_estacion/cargacerca_estacion.ino)
en vez del ejemplo simple de abajo.

Es la máquina de estados (esperando tarjeta → tarjeta leída → cargando →
finalizada, con el relé como traba física) con WiFi + HTTP agregado para
avisarle al backend cada transición:

| Transición en el ESP32                        | Qué manda                                                  |
| ---------------------------------------------- | ----------------------------------------------------------- |
| Arranca / vuelve a `ESPERANDO_TARJETA`         | `POST device-state` → `{ state: "esperando_tarjeta" }`       |
| Lee una tarjeta (`ESPERANDO_INICIO`)           | `POST device-state` → `{ state: "esperando_inicio", cardUid }` |
| Tocás "Iniciar carga" (relé ON)                | `POST device-state` → `{ state: "cargando", cardUid }`       |
| Mientras carga (cada 2 s)                      | `POST /api/measurements`                                     |
| Se desconecta el auto / termina (relé OFF)     | `POST device-state` → `{ state: "finalizada", cardUid }`     |

Configurar arriba del archivo: `WIFI_SSID`, `WIFI_PASSWORD`, `API_BASE_URL`
(tu dominio de Railway, sin `/` al final) y `CHARGER_ID` (tiene que existir
antes en el panel). Librerías necesarias (Arduino Library Manager):
`Adafruit INA219`, `Adafruit GFX`, `Adafruit ILI9341`, `Adafruit PN532`,
`XPT2046_Touchscreen`.

El resto del sketch (NFC, touch, relé, pantalla) es tu lógica original, sin
cambios de comportamiento — solo se le agregó el WiFi y los `POST`.

## Código de ejemplo para ESP32 simple (solo INA219)

Para un ESP32 sin NFC/relé —solo mide y manda—, POST cada 5 segundos.
Configurar `WIFI_SSID`, `WIFI_PASS` y `apiUrl`. El estado del cargador se
infiere por corriente (ver tabla de arriba).

```cpp
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_INA219.h>

// ------- Configuración -------
const char* WIFI_SSID = "TU_WIFI";
const char* WIFI_PASS = "TU_PASSWORD";

// Reemplazar por tu dominio de Railway:
const char* apiUrl = "https://MI-PROYECTO.up.railway.app/api/measurements";

const char* chargerId = "CC-001";
const unsigned long SEND_EVERY_MS = 5000;
// -----------------------------

Adafruit_INA219 ina219;
unsigned long lastSend = 0;

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Conectando a WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("WiFi conectado. IP: ");
  Serial.println(WiFi.localIP());
}

void setup() {
  Serial.begin(115200);
  delay(200);

  if (!ina219.begin()) {
    Serial.println("No se encontró el INA219. Revisar cableado.");
    while (1) delay(1000);
  }
  Serial.println("INA219 OK");

  connectWiFi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  if (millis() - lastSend < SEND_EVERY_MS) return;
  lastSend = millis();

  float shuntVoltage = ina219.getShuntVoltage_mV();
  float busVoltage   = ina219.getBusVoltage_V();
  float current      = ina219.getCurrent_mA();
  float power        = ina219.getPower_mW();
  float sourceVoltage = busVoltage + (shuntVoltage / 1000.0);

  String json = "{";
  json += "\"chargerId\":\"" + String(chargerId) + "\",";
  json += "\"sourceVoltage\":" + String(sourceVoltage, 2) + ",";
  json += "\"busVoltage\":" + String(busVoltage, 2) + ",";
  json += "\"shuntVoltageMv\":" + String(shuntVoltage, 2) + ",";
  json += "\"currentMa\":" + String(current, 2) + ",";
  json += "\"powerMw\":" + String(power, 2);
  json += "}";

  HTTPClient http;
  http.begin(apiUrl);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(json);

  if (code == 201) {
    Serial.println("Datos enviados. HTTP 201");
  } else if (code > 0) {
    Serial.printf("Respuesta HTTP %d: %s\n", code, http.getString().c_str());
  } else {
    Serial.printf("Error de envío: %s\n", http.errorToString(code).c_str());
  }
  http.end();
}
```

> Nota: `http.begin(url)` con HTTPS en el ESP32 core reciente funciona sin
> certificado. Si tu versión exige TLS explícito, usar `WiFiClientSecure` con
> `client.setInsecure()` para el prototipo.

---

## Flujo de validación completo

1. Deployar en Railway y generar el dominio público.
2. Entrar a `https://mi-dominio.up.railway.app`.
3. Crear un cargador: **Cargador Oficina** / `CC-001`.
4. Configurar el ESP32 con `https://mi-dominio.up.railway.app/api/measurements` y `chargerId = "CC-001"`.
5. Enchufar un celular al cargador.
6. Abrir el cargador en el panel y ver estado `● Cargando`, las cards de
   voltaje / corriente / potencia / shunt, la energía en `Wh` y los tres
   gráficos actualizándose cada 2 segundos.
