import { Component, onPatched, onWillStart, useEffect, useRef, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { standardActionServiceProps } from "@web/webclient/actions/action_service";
import { PanelCalificacion } from "./panel_calificacion";

// Mismo orden de progresión que la Selection de cinta_actual/cinta_evaluada
// en Python. Lo usamos para que "ordenar por Cinta" siga el avance real de
// las cintas y no el orden alfabético (que mezclaría amarilla antes que azul
// antes que blanca, sin sentido para una academia de taekwondo).
const ORDEN_CINTAS = [
    "blanca", "naranja", "naranja_avanzada", "amarilla", "amarilla_avanzada",
    "verde", "verde_avanzada", "azul", "azul_avanzada", "roja", "roja_avanzada", "negra",
];
const RANGO_CINTA = Object.fromEntries(ORDEN_CINTAS.map((cinta, indice) => [cinta, indice]));

// resultado ya viene en español desde el modelo (aprobado/reprobado/pendiente),
// así que basta un mapeo fijo de despliegue - a diferencia de cinta_evaluada,
// aquí no hace falta pedirle la Selection al servidor vía fields_get.
const RESULTADO_LABELS = {
    aprobado: "Aprobado",
    reprobado: "Reprobado",
    pendiente: "Pendiente",
};

// Geometría de la "mesa": un lienzo de posición libre donde el sinodal
// arrastra las tarjetas para reproducir la distribución física real de los
// alumnos durante el examen. Es una vista PERSONAL: no se sincroniza entre
// distintos sinodales/dispositivos.
// Ancho de la tarjeta COMPACTA (cerrada). Estimado, a validar en navegador.
const ANCHO_TARJETA = 190;
// Ancho de cada panel abierto en el dock (franja bajo la mesa),
// independiente del de la tarjeta compacta.
const ANCHO_PANEL = 360;
// Alto FIJO de la tarjeta compacta (lo impone estiloCardBox). Abrir una
// tarjeta no cambia su tamaño en el lienzo: su panel va al dock, fuera del
// lienzo. Estimado, a validar en navegador.
const ALTO_TARJETA = 64;
// Reparto de alto entre el marco de la mesa y el dock: el marco toma lo
// que sobra (flex) y el dock un alto en px (state.altoDock) que el sinodal
// ajusta arrastrando el divisor. Ninguno de los dos baja de su mínimo.
const ALTO_MIN_MARCO = 200;
const ALTO_MIN_DOCK = 200;
const ALTO_DIVISOR = 10;
const FRACCION_INICIAL_DOCK = 0.6;  // la 1a vez que se abre el dock
const ALTO_DOCK_RESPALDO = 300;     // si aún no se puede medir la columna
// Margen que se deja alrededor de una tarjeta al llevar el scroll hacia ella.
const MARGEN_SCROLL = 16;
// ANCHO_LIENZO: ancho mínimo del lienzo mientras no se haya medido el marco
// (y rejilla de _siguienteSlot). ALTO_LIENZO_RESPALDO: lo mismo para el
// alto (700 + 80 de margen, el mínimo de antes).
const ANCHO_LIENZO = 1400;
const ALTO_LIENZO_RESPALDO = 780;
const ANCHO_LIENZO_MAX = 4000;
const ALTO_LIENZO_MAX = 3000;
const SEPARACION = 16;
const HOLGURA_ENCIMADO = 40;       // px de traslape tolerado antes de considerar "encimadas"
const MARGEN_MINIMO = 2;           // separación mínima al buscar hueco libre para una card nueva
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1;
const ZOOM_PASO = 0.1;
// Base de z-index de la cabecera de cada tarjeta; se le SUMA su prioridad
// (ver _prioridad) para que la última tarjeta arrastrada o abierta quede
// encima de otras cerradas con las que se encime.
const Z_HEADER_BASE = 500;
// Tope de alumnos simultáneos en la mesa (deshabilita el "+" del Roster).
const MAX_ALUMNOS_MESA = 20;
// Tope de tarjetas por fila en el acomodo automático (ver calcularAcomodo).
const MAX_POR_FILA = 5;

// Acomodo automático de n tarjetas en filas centradas, como se sientan los
// alumnos frente al sinodal: la fila 0 es la de adelante (arriba) y las
// filas de atrás llevan las tarjetas sobrantes. anchoVisible va en
// unidades del lienzo (sin escalar por zoom). Devuelve n posiciones {x, y}
// en orden: fila 0 de izquierda a derecha, luego fila 1, etc. y nunca es 0
// (margen SEPARACION arriba), así que (0,0) sigue siendo el centinela de
// "sin posición". Función pura: exportada para poder probarla aparte.
export function calcularAcomodo(n, anchoVisible) {
    if (n <= 0) {
        return [];
    }
    const maxPorFila = Math.max(1, Math.min(
        MAX_POR_FILA,
        Math.floor((anchoVisible + SEPARACION) / (ANCHO_TARJETA + SEPARACION))
    ));
    const filas = n <= Math.min(3, maxPorFila) ? 1 : Math.max(2, Math.ceil(n / maxPorFila));
    const base = Math.floor(n / filas);
    const extra = n % filas;
    const posiciones = [];
    for (let i = 0; i < filas; i++) {
        const k = base + (i >= filas - extra ? 1 : 0);
        const anchoFila = k * ANCHO_TARJETA + (k - 1) * SEPARACION;
        const x0 = Math.max(0, Math.floor((anchoVisible - anchoFila) / 2));
        const y = SEPARACION + i * (ALTO_TARJETA + SEPARACION);
        for (let j = 0; j < k; j++) {
            posiciones.push({ x: x0 + j * (ANCHO_TARJETA + SEPARACION), y });
        }
    }
    return posiciones;
}

export class TableroCalificacion extends Component {
    static template = "mi_primer_modulo.TableroCalificacion";
    static components = { PanelCalificacion };
    static props = {
        ...standardActionServiceProps,
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.lienzoRef = useRef("lienzo");
        this.marcoRef = useRef("marco");
        this.barraZoomRef = useRef("barraZoom");
        this.columnaRef = useRef("columnaMesa");

        this.state = useState({
            cargando: true,
            roster: [],
            ordenPor: "edad",
            rosterColapsado: false,
            // 'mesa': exámenes en la mesa. 'posiciones': {examenId: {x, y}} en
            // px dentro del lienzo = posición CANÓNICA, la que persiste en
            // posicion_x/posicion_y y que SOLO cambia el drag-and-drop libre.
            // 'tarjetasAbiertas': cuáles muestran su panel en el dock, en
            // ese orden (de izquierda a derecha).
            // 'zIndices': {examenId: numero} orden de "traída al frente";
            // más alto = más arriba visualmente cuando dos tarjetas se enciman.
            // 'expandido': tarjeta a pantalla completa, o null.
            // 'zoom': factor de escala manual del tablero completo (0.5-1).
            // 'altoDock': alto en px del dock, o null hasta la 1a apertura
            // (ver alternarTarjeta). Solo vive en memoria.
            // 'marcoVisible': {ancho, alto} en px de pantalla del área útil
            // del marco (sin barras de scroll ni barra de zoom), medido por
            // el ResizeObserver de abajo; null mientras no se ha medido.
            mesa: [],
            posiciones: {},
            tarjetasAbiertas: [],
            zIndices: {},
            expandido: null,
            zoom: ZOOM_MAX,
            progreso: {},
            altoDock: null,
            marcoVisible: null,
            // 'modoAuto': true = la mesa se acomoda sola en filas centradas
            // (calcularAcomodo) al agregar/quitar; false = posiciones libres
            // del sinodal. Se decide al cargar y pasa a false con el primer
            // arrastre; el botón "Acomodar" lo vuelve a true.
            modoAuto: false,
        });

        // Arrastre libre en curso. No es estado reactivo: solo vive entre
        // pointerdown y pointerup/pointercancel de un mismo gesto.
        this._arrastre = null;
        // Contador monótono para "traer al frente" (abrir o arrastrar una
        // card le asigna el siguiente número; nunca baja).
        this._zSiguiente = 10;
        // Arrastre del divisor marco/dock en curso. No reactivo, igual que
        // _arrastre: solo vive durante un gesto.
        this._arrastreDivisor = null;
        // examenId de la tarjeta recién abierta a la que hay que llevar el
        // scroll del marco en cuanto termine el render (ver onPatched).
        this._scrollPendiente = null;
        // true si al cargar se entró en modo automático y falta aplicar el
        // primer acomodo con la medida real del marco (ver el useEffect de
        // abajo). Se consume una sola vez.
        this._acomodoInicialPendiente = false;

        onWillStart(async () => {
            const eventoId = this.props.action.params.evento_id;

            const examenes = await this.orm.searchRead(
                "taekwondo.examen",
                [["evento_id", "=", eventoId]],
                [
                    "alumno_id", "cinta_evaluada", "resultado", "mejor_examen",
                    "posicion_x", "posicion_y", "en_mesa",
                ]
            );

            const alumnoIds = [...new Set(examenes.map((examen) => examen.alumno_id[0]))];

            // UNA sola llamada trae los datos de TODOS los alumnos del
            // roster juntos, en vez de un viaje al servidor por cada uno.
            const alumnos = await this.orm.read(
                "taekwondo.alumno",
                alumnoIds,
                ["name", "foto", "edad"]
            );
            const alumnosPorId = Object.fromEntries(
                alumnos.map((alumno) => [alumno.id, alumno])
            );

            // orm.read/searchRead traen el valor CRUDO de un campo Selection
            // (la clave técnica, ej. "verde_avanzada"), no la etiqueta
            // traducida - esa traducción normalmente la hace el widget de
            // las vistas estándar de Odoo, usando la metadata del campo que
            // trae fields_get. Como aquí no hay vista ni widget, la pedimos
            // nosotros mismos, UNA sola vez (no por cada examen).
            const camposExamen = await this.orm.call("taekwondo.examen", "fields_get", [], {
                allfields: ["cinta_evaluada"],
                attributes: ["selection"],
            });
            const cintaLabels = Object.fromEntries(camposExamen.cinta_evaluada.selection);

            this.state.roster = examenes.map((examen) => {
                const alumno = alumnosPorId[examen.alumno_id[0]];
                return {
                    examenId: examen.id,
                    name: alumno.name,
                    foto: alumno.foto,
                    edad: alumno.edad,
                    // Guardamos AMBOS: el valor crudo (cintaEvaluada) sigue
                    // siendo necesario para ordenar con RANGO_CINTA, y la
                    // etiqueta (cintaEvaluadaLabel) es la que se muestra.
                    cintaEvaluada: examen.cinta_evaluada,
                    cintaEvaluadaLabel: cintaLabels[examen.cinta_evaluada] || examen.cinta_evaluada,
                    resultado: examen.resultado,
                    mejorExamen: examen.mejor_examen,
                };
            });

            // Otra llamada batch (no una por examen): trae de un solo golpe
            // los criterios de TODOS los exámenes del evento, y con eso
            // contamos cuántos ya tienen calificación por examen.
            const criteriosTodos = await this.orm.searchRead(
                "taekwondo.criterio_calificacion",
                [["examen_id", "in", examenes.map((examen) => examen.id)]],
                ["examen_id", "calificacion"]
            );
            const progreso = Object.fromEntries(examenes.map((examen) => [examen.id, 0]));
            for (const criterio of criteriosTodos) {
                if (criterio.calificacion) {
                    progreso[criterio.examen_id[0]] += 1;
                }
            }
            this.state.progreso = progreso;

            // Restaurar la mesa personal: el criterio de pertenencia es
            // en_mesa (persistido), NO la posición. posicion_x/y solo dicen
            // DÓNDE va si está en la mesa, ya no SI está en la mesa - ver
            // quitarDeMesa/agregarAMesa.
            const mesa = [];
            const posiciones = {};
            for (const examen of examenes) {
                if (examen.en_mesa) {
                    mesa.push(examen.id);
                }
                if (examen.posicion_x || examen.posicion_y) {
                    posiciones[examen.id] = { x: examen.posicion_x, y: examen.posicion_y };
                }
            }
            this.state.mesa = mesa;
            this.state.posiciones = posiciones;
            // Modo automático solo si NINGUNA tarjeta de la mesa tiene
            // posición guardada (mismo criterio que arriba: distinta del
            // centinela (0,0)). El acomodo en sí espera a la primera medida
            // del marco (ver _acomodoInicialPendiente).
            this.state.modoAuto = !mesa.some((id) => posiciones[id]);
            this._acomodoInicialPendiente = this.state.modoAuto;

            this.state.cargando = false;
        });

        // Mide el área útil del marco para que el lienzo la llene como
        // mínimo (ver anchoLienzo/altoLienzo). La dependencia es el propio
        // elemento del marco: cuando la rama t-elif lo desmonta (Expandir)
        // y lo vuelve a montar (Regresar) el elemento cambia, así que Owl
        // corre la limpieza (disconnect) y vuelve a conectar sobre el nuevo.
        // También se limpia al desmontar el componente.
        useEffect(
            (marco) => {
                if (!marco) {
                    return;
                }
                const medir = () => {
                    const barra = this.barraZoomRef.el;
                    const ancho = marco.clientWidth;
                    const alto = marco.clientHeight - (barra ? barra.offsetHeight : 0);
                    const previo = this.state.marcoVisible;
                    // Solo escribimos si cambió: evita renders de más.
                    if (!previo || previo.ancho !== ancho || previo.alto !== alto) {
                        this.state.marcoVisible = { ancho, alto };
                    }
                };
                const observador = new ResizeObserver(medir);
                observador.observe(marco);
                medir();
                return () => observador.disconnect();
            },
            () => [this.marcoRef.el]
        );

        // Primer acomodo en modo automático: en cuanto exista la primera
        // medida del marco (state.marcoVisible), una sola vez.
        useEffect(
            (marcoVisible) => {
                if (this._acomodoInicialPendiente && marcoVisible) {
                    this._acomodoInicialPendiente = false;
                    if (this.state.modoAuto) {
                        this._acomodarTodo();
                    }
                }
            },
            () => [this.state.marcoVisible]
        );

        // Auto-scroll al abrir una tarjeta: corre DESPUÉS del patch, cuando
        // el dock ya está en el DOM y el marco ya se encogió (leer
        // clientHeight/scrollTop fuerza el layout actualizado).
        onPatched(() => {
            if (this._scrollPendiente !== null) {
                const examenId = this._scrollPendiente;
                this._scrollPendiente = null;
                this._scrollHaciaTarjeta(examenId);
            }
        });
    }

    // ---- roster / orden --------------------------------------------------

    get rosterOrdenado() {
        // Copiamos el arreglo antes de ordenar: sort() ordena "en el lugar",
        // y modificar el estado reactivo directamente desde un getter que
        // se llama en cada render es una mala práctica (podría disparar
        // renders extra o dejar el orden inconsistente entre pantallas).
        const roster = [...this.state.roster];
        if (this.state.ordenPor === "edad") {
            roster.sort((a, b) => a.edad - b.edad);
        } else {
            roster.sort((a, b) => RANGO_CINTA[a.cintaEvaluada] - RANGO_CINTA[b.cintaEvaluada]);
        }
        return roster;
    }

    get rosterPorExamenId() {
        return Object.fromEntries(this.state.roster.map((item) => [item.examenId, item]));
    }

    ordenarPor(criterio) {
        this.state.ordenPor = criterio;
    }

    alternarRoster() {
        this.state.rosterColapsado = !this.state.rosterColapsado;
    }

    // ---- mesa: agregar / quitar / abrir / expandir ---------------------

    async agregarAMesa(examenId) {
        if (this.state.mesa.includes(examenId)) {
            return;
        }
        // Modo automático: se reacomoda TODA la mesa (ignorando la posición
        // vieja que la tarjeta pudiera tener guardada). Modo manual: si ya
        // tenía posición (el sinodal la había acomodado y luego la quitó),
        // se respeta y reaparece ahí; solo si nunca tuvo posición se le
        // asigna un hueco automático (para que no aparezca amontonada en
        // 0,0 encima de otra card).
        if (!this.state.modoAuto && !this.state.posiciones[examenId]) {
            this.state.posiciones[examenId] = this._siguienteSlot();
        }
        this.state.mesa.push(examenId);
        if (this.state.modoAuto) {
            this._acomodarTodo();
        }
        try {
            await this.orm.write("taekwondo.examen", [examenId], { en_mesa: true });
        } catch (error) {
            // Reversión optimista: si no se pudo persistir, el alumno no
            // se queda "en la mesa" solo en el navegador de este sinodal -
            // eso volvería a divergir del servidor, el mismo tipo de bug
            // que estamos arreglando.
            this.state.mesa = this.state.mesa.filter((id) => id !== examenId);
            if (this.state.modoAuto) {
                // Deshace el hueco que se le había hecho a la tarjeta.
                this._acomodarTodo();
            }
            this.notification.add(
                "No se pudo agregar el alumno a la mesa. Intenta de nuevo.",
                { type: "danger" }
            );
        }
    }

    async quitarDeMesa(examenId) {
        // "Quitar" es PURAMENTE VISUAL: solo saca el examenId del arreglo
        // 'mesa' y persiste en_mesa=False. NO se borra 'state.posiciones'
        // ni se toca posicion_x/posicion_y en el servidor, para que al
        // volver a agregar al alumno con "+" reaparezca exactamente donde
        // el sinodal lo dejó.
        this.state.mesa = this.state.mesa.filter((id) => id !== examenId);
        this.state.tarjetasAbiertas = this.state.tarjetasAbiertas.filter((id) => id !== examenId);
        if (this.state.expandido === examenId) {
            this.state.expandido = null;
        }
        try {
            await this.orm.write("taekwondo.examen", [examenId], { en_mesa: false });
            if (this.state.modoAuto) {
                this._acomodarTodo();
            }
        } catch (error) {
            // Revertimos SOLO la pertenencia a la mesa: tarjetasAbiertas y
            // expandido no se restauran porque su estado no es lo que
            // falló en persistir y reabrir/expandir de vuelta sin que el
            // usuario lo pidiera sería más confuso que útil.
            this.state.mesa.push(examenId);
            this.notification.add(
                "No se pudo quitar el alumno de la mesa. Intenta de nuevo.",
                { type: "danger" }
            );
        }
    }

    // ---- acomodo automático ------------------------------------------

    // true cuando la mesa llegó al tope: deshabilita el "+" del Roster.
    get mesaLlena() {
        return this.state.mesa.length >= MAX_ALUMNOS_MESA;
    }

    // Reacomoda TODA la mesa en filas centradas (calcularAcomodo), en el
    // orden de entrada de state.mesa, sobre el ancho visible del marco en
    // unidades del lienzo (o ANCHO_LIENZO si aún no se ha medido). SOLO
    // escribe en memoria (state.posiciones): nunca al servidor.
    _acomodarTodo() {
        const anchoVisible = this._minimoLienzo("ancho", ANCHO_LIENZO);
        const acomodo = calcularAcomodo(this.state.mesa.length, anchoVisible);
        this.state.mesa.forEach((id, i) => {
            this.state.posiciones[id] = acomodo[i];
        });
    }

    // Botón "Acomodar": borra en el servidor las posiciones de TODOS los
    // exámenes del evento (un solo write) y, si eso funcionó, vuelve al
    // modo automático y reacomoda. Si falla no toca nada local. No cierra
    // ni toca los paneles abiertos.
    async acomodar() {
        const ids = this.state.roster.map((item) => item.examenId);
        try {
            await this.orm.write("taekwondo.examen", ids, { posicion_x: 0, posicion_y: 0 });
        } catch (error) {
            console.error("No se pudieron borrar las posiciones de la mesa", error);
            return;
        }
        for (const id of ids) {
            delete this.state.posiciones[id];
        }
        this.state.modoAuto = true;
        this._acomodarTodo();
    }

    // Primer arrastre en modo automático: la mesa pasa a modo manual y se
    // persisten las posiciones actuales (las del acomodo, que solo vivían en
    // memoria) de todas las demás tarjetas en mesa, para que al recargar
    // aparezcan donde el sinodal las vio. La arrastrada la guarda
    // alSoltarManija como siempre.
    async _pasarAManual(examenIdArrastrado) {
        this.state.modoAuto = false;
        const otras = this.state.mesa.filter((id) => id !== examenIdArrastrado && this.state.posiciones[id]);
        try {
            await Promise.all(otras.map((id) => {
                const p = this.state.posiciones[id];
                return this.orm.write("taekwondo.examen", [id], {
                    posicion_x: p.x === 0 && p.y === 0 ? 1 : p.x,
                    posicion_y: p.y,
                });
            }));
        } catch (error) {
            console.error("No se pudieron guardar las posiciones de la mesa", error);
        }
    }

    estaAbierta(examenId) {
        return this.state.tarjetasAbiertas.includes(examenId);
    }

    alternarTarjeta(examenId) {
        if (this.state.tarjetasAbiertas.includes(examenId)) {
            this.state.tarjetasAbiertas = this.state.tarjetasAbiertas.filter((id) => id !== examenId);
        } else {
            if (this.state.altoDock === null) {
                this.state.altoDock = this._altoDockInicial();
            }
            this.state.tarjetasAbiertas.push(examenId);
            this._traerAlFrente(examenId);
            // Solo al abrir: el scroll se aplica en onPatched, con el marco
            // ya encogido por el dock.
            this._scrollPendiente = examenId;
        }
    }

    expandir(examenId) {
        this.state.expandido = examenId;
    }

    regresar() {
        this.state.expandido = null;
    }

    etiquetaResultado(valor) {
        return RESULTADO_LABELS[valor] || valor;
    }

    // ---- geometría del lienzo -----------------------------------------

    get altoLienzo() {
        // Alto real de cada card SIEMPRE es ALTO_TARJETA (su panel abierto
        // va al dock, fuera del lienzo): el lienzo crece solo según hasta
        // dónde se arrastró alguna card.
        // Mínimo: el alto útil del marco en unidades del lienzo (÷ zoom).
        let maxAbajo = this._minimoLienzo("alto", ALTO_LIENZO_RESPALDO);
        for (const id of this.state.mesa) {
            maxAbajo = Math.max(maxAbajo, this._pos(id).y + ALTO_TARJETA + 80);
        }
        return Math.min(maxAbajo, ALTO_LIENZO_MAX);
    }

    get anchoLienzo() {
        // Mínimo: el ancho útil del marco en unidades del lienzo (÷ zoom).
        let maxDerecha = this._minimoLienzo("ancho", ANCHO_LIENZO);
        for (const id of this.state.mesa) {
            maxDerecha = Math.max(maxDerecha, this._pos(id).x + ANCHO_TARJETA + 80);
        }
        return Math.min(maxDerecha, ANCHO_LIENZO_MAX);
    }

    // Tamaño útil del marco ('ancho' o 'alto') pasado a unidades del lienzo,
    // o 'respaldo' si aún no se ha medido. floor: nunca un px de más que
    // genere barras de scroll por redondeo.
    _minimoLienzo(eje, respaldo) {
        const visible = this.state.marcoVisible;
        if (!visible) {
            return respaldo;
        }
        return Math.floor(visible[eje] / this.state.zoom);
    }

    // Estilo del canvas: tamaño dinámico (crece con las cards) + el zoom
    // manual aplicado a TODO el lienzo, nunca a las cards individuales.
    get estiloLienzo() {
        return `position: relative; width: ${this.anchoLienzo}px; height: ${this.altoLienzo}px; ` +
            `transform: scale(${this.state.zoom}); transform-origin: top left;`;
    }

    // Posición libre de cada card: x/y propios y ancho fijo de tarjeta
    // compacta. SIN z-index propio a propósito: si el wrapper tuviera un
    // z-index numérico, se volvería un stacking context nuevo y atraparía
    // dentro suyo a la cabecera, impidiéndole competir por z-index contra
    // las de las demás cards - ver estiloCabecera.
    estiloTarjeta(examenId) {
        const p = this._pos(examenId);
        return `position: absolute; left: ${p.x}px; top: ${p.y}px; width: ${ANCHO_TARJETA}px;`;
    }

    // Contenedor externo (el que lleva el borde de color por resultado).
    // height = ALTO_TARJETA (border-box, borde incluido): fija el alto de la
    // tarjeta compacta para que coincida con _headerRect.
    estiloCardBox(examenId) {
        return `position: relative; height: ${ALTO_TARJETA}px;`;
    }

    // Cabecera de la tarjeta compacta: Z_HEADER_BASE + prioridad, para que
    // la última card arrastrada o abierta pinte encima de otras cerradas con
    // las que se encime. position:relative para que el z-index aplique.
    // Si su panel está abierto en el dock, se resalta con un anillo interior
    // primario y fondo tintado: queda DENTRO del borde de color por
    // resultado, sin taparlo. (Cerrada usa la clase bg-light, ver plantilla:
    // esa clase lleva !important y taparía este fondo.)
    estiloCabecera(examenId) {
        const prioridad = this._prioridad(examenId);
        const base = `position: relative; z-index: ${Z_HEADER_BASE + prioridad};`;
        return this.estaAbierta(examenId)
            ? `${base} box-shadow: inset 0 0 0 3px var(--bs-primary); ` +
                `background-color: var(--bs-primary-bg-subtle, rgba(var(--bs-primary-rgb), 0.15));`
            : base;
    }

    // ---- dock de paneles abiertos -------------------------------------

    // Dock: alto en px elegido con el divisor; no crece ni se encoge con
    // flex (el marco es quien absorbe el resto de la columna).
    get estiloDock() {
        return `height: ${this.state.altoDock || ALTO_DOCK_RESPALDO}px; flex: 0 0 auto; ` +
            `flex-wrap: nowrap; align-items: stretch; gap: 16px; overflow-x: auto;`;
    }

    get estiloDivisor() {
        return `height: ${ALTO_DIVISOR}px; flex: 0 0 auto; cursor: row-resize; touch-action: none;`;
    }

    // Cada panel del dock: ancho fijo (no se encoge al haber varios; el dock
    // hace scroll horizontal), alto = el del dock (align-items: stretch) y
    // scroll vertical propio.
    get estiloPanelDock() {
        return `width: ${ANCHO_PANEL}px; flex-shrink: 0; overflow-y: auto;`;
    }

    // Alto disponible para marco + dock: desde el borde superior del marco
    // hasta el fondo de la columna, menos el divisor. null si no se puede
    // medir (marco o columna no montados).
    _altoDisponible() {
        const marco = this.marcoRef.el;
        const columna = this.columnaRef.el;
        if (!marco || !columna) {
            return null;
        }
        return columna.getBoundingClientRect().bottom - marco.getBoundingClientRect().top - ALTO_DIVISOR;
    }

    _limitarAltoDock(alto, disponible) {
        return Math.max(ALTO_MIN_DOCK, Math.min(alto, disponible - ALTO_MIN_MARCO));
    }

    _altoDockInicial() {
        const disponible = this._altoDisponible();
        if (disponible === null) {
            return ALTO_DOCK_RESPALDO;
        }
        return Math.round(this._limitarAltoDock(disponible * FRACCION_INICIAL_DOCK, disponible));
    }

    // ---- divisor marco/dock (Pointer Events, mismo patrón que la manija) --
    //
    // Arrastrar hacia ARRIBA agranda el dock; hacia abajo lo achica. Sin
    // zoom ni _limitar (el divisor está fuera del lienzo) y sin escribir al
    // servidor: el alto solo vive en memoria.

    alPresionarDivisor(ev) {
        const disponible = this._altoDisponible();
        if (disponible === null) {
            return;
        }
        ev.preventDefault();
        ev.target.setPointerCapture(ev.pointerId);
        this._arrastreDivisor = {
            pointerId: ev.pointerId,
            yInicial: ev.clientY,
            altoInicial: this.state.altoDock || ALTO_DOCK_RESPALDO,
            disponible,
        };
    }

    alMoverDivisor(ev) {
        const a = this._arrastreDivisor;
        if (!a || ev.pointerId !== a.pointerId) {
            return;
        }
        ev.preventDefault();
        const alto = a.altoInicial + (a.yInicial - ev.clientY);
        this.state.altoDock = Math.round(this._limitarAltoDock(alto, a.disponible));
    }

    alSoltarDivisor(ev) {
        const a = this._arrastreDivisor;
        if (!a || ev.pointerId !== a.pointerId) {
            return;
        }
        if (ev.target.hasPointerCapture(ev.pointerId)) {
            ev.target.releasePointerCapture(ev.pointerId);
        }
        this._arrastreDivisor = null;
    }

    // ---- auto-scroll hacia una tarjeta ----------------------------------

    // Scroll MÍNIMO del marco (nunca de la página) para que la tarjeta quede
    // completa a la vista, con MARGEN_SCROLL alrededor. Si ya se ve entera,
    // no hace nada. Coordenadas en px del contenido scrolleable del marco:
    // el lienzo está escalado desde su esquina superior izquierda, así que
    // la tarjeta va en (x·zoom, y·zoom) a partir del origen del lienzo, y la
    // barra de zoom sticky tapa la franja superior del área visible.
    _scrollHaciaTarjeta(examenId) {
        const marco = this.marcoRef.el;
        const lienzo = this.lienzoRef.el;
        if (!marco || !lienzo) {
            return;
        }
        const zoom = this.state.zoom;
        const p = this._pos(examenId);
        const izq = lienzo.offsetLeft + p.x * zoom;
        const arriba = lienzo.offsetTop + p.y * zoom;
        const der = izq + ANCHO_TARJETA * zoom;
        const abajo = arriba + ALTO_TARJETA * zoom;

        const barra = this.barraZoomRef.el;
        const altoBarra = barra ? barra.offsetHeight : 0;
        const vistaIzq = marco.scrollLeft;
        const vistaDer = vistaIzq + marco.clientWidth;
        const vistaArriba = marco.scrollTop + altoBarra;
        const vistaAbajo = marco.scrollTop + marco.clientHeight;

        let left = marco.scrollLeft;
        if (izq < vistaIzq) {
            left = izq - MARGEN_SCROLL;
        } else if (der > vistaDer) {
            left = der + MARGEN_SCROLL - marco.clientWidth;
        }
        let top = marco.scrollTop;
        if (arriba < vistaArriba) {
            top = arriba - MARGEN_SCROLL - altoBarra;
        } else if (abajo > vistaAbajo) {
            top = abajo + MARGEN_SCROLL - marco.clientHeight;
        }
        if (left !== marco.scrollLeft || top !== marco.scrollTop) {
            marco.scrollTo({ left: Math.max(0, left), top: Math.max(0, top) });
        }
    }

    // ---- geometría / colisión (rectángulos) -----------------------------

    _pos(examenId) {
        return this.state.posiciones[examenId] || { x: 0, y: 0 };
    }

    _rect(pos, dims) {
        return { x: pos.x, y: pos.y, w: dims.w, h: dims.h };
    }

    _solapeEje(a0, a1, b0, b1) {
        return Math.min(a1, b1) - Math.max(a0, b0);
    }

    // Dos rectángulos "chocan" si se traslapan en AMBOS ejes por más de
    // HOLGURA_ENCIMADO px. Cada rectángulo se infla MARGEN_MINIMO px por
    // lado antes de comparar (ver _siguienteSlot).
    _seSolapan(a, b) {
        return (
            this._solapeEje(
                a.x - MARGEN_MINIMO, a.x + a.w + MARGEN_MINIMO,
                b.x - MARGEN_MINIMO, b.x + b.w + MARGEN_MINIMO
            ) > HOLGURA_ENCIMADO &&
            this._solapeEje(
                a.y - MARGEN_MINIMO, a.y + a.h + MARGEN_MINIMO,
                b.y - MARGEN_MINIMO, b.y + b.h + MARGEN_MINIMO
            ) > HOLGURA_ENCIMADO
        );
    }

    _limitar(x, y) {
        const maxX = Math.max(0, this.anchoLienzo - ANCHO_TARJETA);
        const maxY = Math.max(0, this.altoLienzo - ALTO_TARJETA);
        return [Math.max(0, Math.min(x, maxX)), Math.max(0, Math.min(y, maxY))];
    }

    // Hueco libre para una card NUEVA (nunca antes posicionada): recorre una
    // rejilla virtual de ANCHO_TARJETA+SEPARACION y devuelve la primera
    // celda que no choque con ninguna card ya colocada. Solo se usa al
    // agregar por primera vez (agregarAMesa) - nunca reposiciona una card
    // que ya tiene posición guardada.
    _siguienteSlot() {
        const colocadas = this.state.mesa
            .filter((id) => this.state.posiciones[id])
            .map((id) => this._headerRect(id));
        const dims = { w: ANCHO_TARJETA, h: ALTO_TARJETA };
        const cols = Math.max(1, Math.floor(ANCHO_LIENZO / (ANCHO_TARJETA + SEPARACION)));
        for (let fila = 0; fila < 60; fila++) {
            for (let col = 0; col < cols; col++) {
                const x = col * (ANCHO_TARJETA + SEPARACION);
                const y = fila * (ALTO_TARJETA + SEPARACION);
                const rect = this._rect({ x, y }, dims);
                if (!colocadas.some((r) => this._seSolapan(rect, r))) {
                    return { x, y };
                }
            }
        }
        return { x: 0, y: 0 };
    }

    // ---- rectángulo de la tarjeta compacta ------------------------------

    // Rectángulo de la card en el lienzo: SIEMPRE del tamaño de la tarjeta
    // compacta, esté abierta o no (su panel va al dock). Lo usa _siguienteSlot.
    _headerRect(examenId) {
        return this._rect(this._pos(examenId), { w: ANCHO_TARJETA, h: ALTO_TARJETA });
    }

    // Prioridad de una card para el orden de encimado (z-index de su
    // cabecera, ver estiloCabecera): el contador de _traerAlFrente si alguna
    // vez se abrió o arrastró, o si nunca se tocó, -examenId como desempate
    // ESTABLE y siempre único, que queda por debajo de cualquier prioridad
    // asignada por _traerAlFrente (arranca en 11, siempre positiva).
    _prioridad(examenId) {
        return this.state.zIndices[examenId] !== undefined
            ? this.state.zIndices[examenId]
            : -examenId;
    }

    // Contador monótono de "traída al frente": pintar por encima de las
    // demás cards. Nunca baja, así que "la última tocada" queda siempre
    // arriba de lo que ya estaba.
    _traerAlFrente(examenId) {
        this._zSiguiente += 1;
        this.state.zIndices[examenId] = this._zSiguiente;
    }

    // ---- zoom manual -------------------------------------------------

    zoomIn() {
        this.state.zoom = Math.min(ZOOM_MAX, Math.round((this.state.zoom + ZOOM_PASO) * 10) / 10);
    }

    zoomOut() {
        this.state.zoom = Math.max(ZOOM_MIN, Math.round((this.state.zoom - ZOOM_PASO) * 10) / 10);
    }

    // ---- arrastre libre con Pointer Events (mouse + táctil) -------------
    //
    // Se dispara SOLO desde la manija (⠿): el resto de la tarjeta (click de
    // Expandir/Quitar/alternar) usa sus propios manejadores y nunca ve estos
    // eventos. touch-action:none en la manija evita que el navegador
    // interprete el gesto como scroll de la página en vez de drag.

    alPresionarManija(ev, examenId) {
        const lienzo = this.lienzoRef.el;
        if (!lienzo) {
            return;
        }
        ev.preventDefault();
        // setPointerCapture: los pointermove/pointerup que siguen se siguen
        // recibiendo aunque el dedo/cursor salga de la manija (no hacen
        // falta listeners en window).
        ev.target.setPointerCapture(ev.pointerId);
        const rect = lienzo.getBoundingClientRect();
        const p = this._pos(examenId);
        // clientX/clientY están en espacio de PANTALLA; el lienzo tiene
        // transform:scale(zoom), así que hay que dividir por el zoom para
        // volver a coordenadas del canvas - si no, arrastrar con zoom
        // distinto de 100% desfasaría la tarjeta del cursor.
        const canvasX = (ev.clientX - rect.left) / this.state.zoom;
        const canvasY = (ev.clientY - rect.top) / this.state.zoom;
        this._arrastre = {
            pointerId: ev.pointerId,
            examenId,
            desfaseX: canvasX - p.x,
            desfaseY: canvasY - p.y,
            movido: false,
        };
        this._traerAlFrente(examenId);
    }

    alMoverManija(ev) {
        const a = this._arrastre;
        if (!a || ev.pointerId !== a.pointerId) {
            return;
        }
        ev.preventDefault();
        const lienzo = this.lienzoRef.el;
        if (!lienzo) {
            return;
        }
        const rect = lienzo.getBoundingClientRect();
        const canvasX = (ev.clientX - rect.left) / this.state.zoom;
        const canvasY = (ev.clientY - rect.top) / this.state.zoom;
        const [x, y] = this._limitar(canvasX - a.desfaseX, canvasY - a.desfaseY);
        a.movido = true;
        this.state.posiciones[a.examenId] = { x, y };
    }

    async alSoltarManija(ev) {
        const a = this._arrastre;
        if (!a || ev.pointerId !== a.pointerId) {
            return;
        }
        if (ev.target.hasPointerCapture(ev.pointerId)) {
            ev.target.releasePointerCapture(ev.pointerId);
        }
        this._arrastre = null;
        if (!a.movido) {
            return;
        }
        if (this.state.modoAuto) {
            // Sin await: se lanza en paralelo al write de la arrastrada.
            this._pasarAManual(a.examenId);
        }
        const p = this.state.posiciones[a.examenId];
        // (0,0) es el centinela de "sin posición": si la tarjeta acabó justo
        // ahí, la empujamos 1px para que sí se persista.
        const x = p.x === 0 && p.y === 0 ? 1 : p.x;
        await this.orm.write("taekwondo.examen", [a.examenId], {
            posicion_x: x,
            posicion_y: p.y,
        });
    }

    // ---- callbacks del panel -----------------------------------------

    async onCriterioGuardado(examenId) {
        // Solo repreguntamos por ESTE examen (4 filas), no por todo el
        // evento de nuevo: mismo espíritu de "batch, no uno por uno" pero
        // aplicado a la actualización puntual que sí necesitamos aquí.
        const criterios = await this.orm.searchRead(
            "taekwondo.criterio_calificacion",
            [["examen_id", "=", examenId]],
            ["calificacion"]
        );
        this.state.progreso[examenId] = criterios.filter((c) => c.calificacion).length;
    }

    onResultadoCambiado(examenId, valor) {
        // A diferencia de onCriterioGuardado, aquí NO volvemos a preguntarle
        // al servidor: el Panel ya sabe con certeza qué valor acaba de
        // escribir (él mismo lo mandó), así que nos lo pasa directo y solo
        // actualizamos el estado local. rosterPorExamenId[examenId] es la
        // MISMA referencia de objeto que vive dentro de state.roster (el
        // getter solo la busca, no la copia), así que mutarla aquí sí
        // dispara el re-render de quien esté leyendo ese dato.
        const item = this.rosterPorExamenId[examenId];
        if (item) {
            item.resultado = valor;
        }
    }

    onMejorExamenCambiado(examenId, valor) {
        // Mismo mecanismo que onResultadoCambiado: el Panel ya sabe el
        // valor exacto, así que solo actualizamos la referencia local.
        const item = this.rosterPorExamenId[examenId];
        if (item) {
            item.mejorExamen = valor;
        }
    }
}

registry.category("actions").add("mi_primer_modulo.tablero_calificacion", TableroCalificacion);
