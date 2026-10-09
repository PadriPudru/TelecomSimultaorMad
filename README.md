# Gemelo digital RF · Madrid

Demo visual de un **gemelo digital de red móvil urbana**: una ciudad 3D estilo Madrid centro donde se simula cómo se propagan las ondas de radio, se colocan antenas y se predicen fallos antes de que ocurran.

> ⚠️ **Demo conceptual.** La física de propagación está simplificada y todos los datos (edificios, antenas, telemetría, alertas) son sintéticos. No sirve para planificación real.

## Qué incluye

- **Ciudad 3D procedural** (~1.300 edificios): manzanas con patio, Gran Vía, Castellana, Retiro y Sol.
- **Mapa de cobertura** RSRP / SINR sobre las calles, con sombras de los edificios.
- **Tres bandas**: 700 MHz, 3,5 GHz y 26 GHz, con comportamientos muy distintos.
- **Frentes de onda y trazado de rayos** con rebotes en fachadas y suelo.
- **Colocación de antenas** con un clic y **optimizador** que propone la mejor azotea.
- **Predicción de fallos**: telemetría simulada, alertas con cuenta atrás, mantenimiento preventivo y recálculo de la cobertura cuando cae una estación.

## Cómo ejecutarla

Requiere [Node.js](https://nodejs.org/) 18 o superior.

```bash
cd demo
npm install
npm run dev
```

Se abre en http://localhost:5173.

## Estructura

| Archivo | Contenido |
|---|---|
| `demo/src/city.js` | Generación de la ciudad, rejilla de alturas y raycast contra edificios |
| `demo/src/rf.js` | Modelo de propagación simplificado, SINR, rayos y optimizador |
| `demo/src/main.js` | Escena Three.js, interfaz, simulación y alertas |
| `demo/src/style.css` | Estilos de la interfaz |

## Siguientes pasos hacia un gemelo real

1. Geometría real: Catastro INSPIRE + LiDAR PNOA (IGN) + OpenStreetMap.
2. Materiales por frecuencia según ITU-R P.2040.
3. Motor de trazado de rayos físico (p. ej. NVIDIA Sionna RT) en GPU.
4. Calibración con medidas de campo (drive tests).
5. Ingesta de KPIs y alarmas reales para la detección de anomalías.
