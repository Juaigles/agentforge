# Política de seguridad

## Qué protege AgentForge y qué no

AgentForge está pensado para **un usuario en su propio equipo**. Su modelo de amenazas:

| Amenaza | Defensa |
|---|---|
| Una página web maliciosa abierta en el mismo navegador intenta usar la API local | El servidor escucha solo en `127.0.0.1`, rechaza las peticiones con un `Host` ajeno (DNS rebinding) y las que proceden de otro sitio (CSRF), y sirve una política de contenido estricta |
| Un modelo (o una página que el modelo ha leído) intenta llegar a tu red local o a la propia API | Las herramientas de red bloquean redes privadas y la propia API, con la IP fijada tras validarla; no reenvían credenciales al redirigir a otro sitio |
| Un modelo intenta leer o escribir fuera de su carpeta | Las herramientas de archivos están confinadas al espacio de trabajo, con cuota |
| La salida de un modelo intenta ejecutar código en la interfaz | Se pinta como Markdown saneado (DOMPurify); hay tests con entradas hostiles |
| Robo de la base de datos | Las API keys, las cabeceras con credenciales, los secretos de webhooks y las variables de los servidores MCP están cifrados (AES-256-GCM) con una clave que está en otro archivo (`data/secret.key`) |
| Código generado por un modelo (`run_javascript`) | Desactivado por defecto. Proceso sin red, sin sistema de archivos y con límites; para código no confiable, el modo contenedor |

Lo que **no** cubre:

- **No hay cuentas ni permisos.** La clave de acceso (`AGENTFORGE_TOKEN`) es única: quien la tiene puede hacerlo
  todo, incluido activar la ejecución de código.
- **Quien puede leer la carpeta `data/` puede leerlo todo**: la clave de cifrado está en ella. Las copias de
  seguridad también la contienen.
- **Un servidor MCP local es un programa con tus permisos.** AgentForge no lo aísla.
- **El aislamiento en proceso de `run_javascript` no es una frontera del sistema operativo.**
- **Los webhooks no protegen frente a repeticiones**: una petición firmada capturada se puede reenviar.
- **Exponerlo a Internet no está contemplado.** Para usarlo desde otros equipos de una red de confianza hace falta
  la clave de acceso y conviene ponerle delante un proxy con TLS (declarando su nombre en
  `AGENTFORGE_ALLOWED_HOSTS`); el servidor no cifra el tráfico por sí mismo.

El detalle de cada defensa y de cómo se ha probado está en el [README](README.md) («Seguridad») y en
[TEST_RESULTS.md](TEST_RESULTS.md); lo que no se ha podido verificar, en su sección 4.

## Versiones con soporte

Solo la última. El proyecto no tiene todavía versiones publicadas.

## Cómo informar de una vulnerabilidad

El proyecto no está publicado y no tiene un canal de contacto público. Si lo usas a partir de una copia,
comunícalo en privado a quien te la facilitó y no abras una incidencia pública con los detalles. Incluye:

- versión (Panel → Sistema) y sistema operativo,
- pasos para reproducirlo o una prueba de concepto,
- qué permite hacer y con qué condiciones previas.

Cuando el proyecto se publique, este apartado debe sustituirse por una dirección de contacto real y un plazo de
respuesta.

## Recomendaciones de uso

- No definas `HOST` distinto de `127.0.0.1` salvo que lo necesites, y entonces usa una clave larga y aleatoria.
- Deja desactivados «Permitir redes privadas» y «Permitir ejecución de código» si no los necesitas.
- Añade solo servidores MCP y herramientas HTTP que conozcas; revisa los avisos al importar un archivo ajeno.
- Guarda las copias de seguridad como guardarías tus contraseñas.
