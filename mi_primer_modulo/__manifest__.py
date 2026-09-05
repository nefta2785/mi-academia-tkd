{
    'name': 'Mi Primer Módulo',
    'version': '1.0',
    'summary': 'Módulo de prueba para confirmar que el ambiente funciona',
    'depends': ['base', 'account'],
    'data': [
        'security/academia_groups.xml',
        'security/ir.model.access.csv',
        'data/ir_sequence_data.xml',
        'views/dashboard_views.xml',
        'views/alumno_views.xml',
        'views/examen_views.xml',
        'views/evento_examen_views.xml',
        'views/reporte_ganancias_views.xml',
        'views/retiro_socio_views.xml',
        'views/torneo_views.xml',
        'data/cron_mensualidad.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'mi_primer_modulo/static/src/js/**/*.js',
            'mi_primer_modulo/static/src/xml/**/*.xml',
        ],
    },
    'installable': True,
    'application': True,
}
