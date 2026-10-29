# 🎨 Pinturillo Clone

Juego multijugador de **dibujar y adivinar** en tiempo real, estilo *Pinturillo 2*.
Construido con **Node.js + Express + Socket.io**, **HTML5 Canvas** y **Tailwind CSS** (vía CDN).

## Requisitos

- [Node.js](https://nodejs.org/) 18 o superior
- Conexión a internet en el navegador (Tailwind y la fuente se cargan por CDN)

## Instalación y ejecución local

```bash
cd pinturillo-clone
npm install
node server.js          # o: npm start
```

Abre <http://localhost:3000>.

## Cómo probarlo localmente (varios jugadores en una sola computadora)

1. En una pestaña, pulsa **Crear sala**, escribe tu nombre y entra. Serás el **administrador** 👑.
2. Copia el código de la sala (botón 📋 arriba, o el código de 5 letras).
3. Abre **otras pestañas** (mejor una ventana de incógnito para cada jugador, porque la sesión se guarda por pestaña),
   entra a <http://localhost:3000>, pulsa **Unirse a sala** y escribe otro nombre + el código.
4. En el **panel del administrador**:
   - Marca la casilla ✏️ de quienes serán **dibujantes** (el número indica el orden de turnos).
   - Escribe las **palabras secretas** (una por línea).
   - Pulsa **▶ Iniciar partida**.
5. El dibujante ve la palabra y dibuja; los demás escriben en el chat. ¡Gana quien acierte más rápido!

> 💡 Para probar desde otro dispositivo de tu red (celular, otra laptop), usa la IP local de tu computadora:
> `http://192.168.x.x:3000`.

### Probar con turnos cortos

El turno dura **190 s** como máximo. Para pruebas puedes bajarlo con una variable de entorno:

```bash
DURACION_TURNO=20 PAUSA_ENTRE_TURNOS=3 node server.js        # Linux / macOS
$env:DURACION_TURNO=20; $env:PAUSA_ENTRE_TURNOS=3; node server.js   # PowerShell
```

## Reglas del juego

| Concepto | Detalle |
|---|---|
| Duración | Máximo **190 segundos** por palabra |
| Validación | Ignora mayúsculas, acentos y signos (la «ñ» se compara como «n») |
| Puntos del adivinador | De **50** (último segundo) a **500** (primer segundo), decreciente en forma lineal según el tiempo restante |
| Bonus del dibujante | **25 %** de los puntos de cada adivinador que acierta |
| Fin de turno | Al acabarse el tiempo **o** cuando todos los adivinadores conectados aciertan |
| Fin de partida | Al agotarse la lista de palabras: podio y tabla de posiciones |
| Chat privado | Quien ya acertó y el dibujante chatean en privado para no revelar la palabra |

Fórmula: `puntos = 50 + 450 × (segundosRestantes / 190)`

## Estructura del proyecto

```
pinturillo-clone/
├── package.json          # Dependencias: express, socket.io
├── server.js             # Servidor: salas, turnos, temporizador, puntuación, sockets
└── public/
    ├── index.html        # Lobby: crear / unirse a sala
    ├── room.html         # Sala: admin, canvas, herramientas, chat, puntajes
    ├── css/style.css     # Estilos complementarios a Tailwind
    └── js/client.js      # Cliente: canvas, eventos Socket.io, UI dinámica
```

## Eventos de Socket.io (resumen)

**Cliente → servidor:** `crear_sala`, `verificar_sala`, `unirse_sala`, `salir_sala`,
`admin_renombrar`, `admin_dibujantes`, `admin_palabras`, `admin_expulsar`, `admin_iniciar`,
`admin_saltar_turno`, `admin_terminar`, `admin_nueva_partida`,
`dibujo_segmentos`, `dibujo_limpiar`, `chat_mensaje`.

**Servidor → cliente:** `sala_estado`, `admin_config`, `turno_inicio`, `turno_palabra`, `turno_fin`,
`juego_fin`, `volver_lobby`, `dibujo_segmentos`, `dibujo_limpiar`, `dibujo_historial`,
`chat_mensaje`, `chat_historial`, `expulsado`, `sesion_reemplazada`.

## Despliegue

### Render

1. Sube el proyecto a un repositorio de GitHub.
2. En Render: **New → Web Service** y conecta el repositorio.
3. **Build Command:** `npm install` · **Start Command:** `node server.js`
4. Render define la variable `PORT` automáticamente (el servidor ya la respeta). Opcional: Health Check Path `/salud`.

### Railway

1. **New Project → Deploy from GitHub repo**.
2. Railway detecta Node.js y ejecuta `npm start` solo. Genera un dominio público en *Settings → Networking*.

> ⚠️ Las salas viven **en memoria**: si el servidor se reinicia (o el plan gratuito lo duerme), se pierden.
> Usa una sola instancia del servicio (no escales a varias réplicas) para que todos los jugadores compartan el mismo estado.

## Notas

- Al recargar la página dentro de una sala, el jugador **se reconecta** conservando puntaje y rol (token en `sessionStorage`).
- Si el administrador se desconecta más de 45 s, la administración pasa a otro jugador conectado.
- Si el dibujante se desconecta más de 15 s, el turno termina.
- El administrador conoce de antemano las palabras (él las escribe), así que lo ideal es que modere o dibuje.
