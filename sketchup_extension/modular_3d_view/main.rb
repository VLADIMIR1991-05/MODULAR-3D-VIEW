require 'sketchup.rb'
require 'fileutils'

module Modular3D
  module View
    VIEW_URL = 'https://modular-3d-view.lenin19910527.workers.dev'.freeze

    def self.publish
      model = Sketchup.active_model
      if model.nil? || model.entities.empty?
        UI.messagebox('Abre un modelo SketchUp antes de publicarlo.')
        return
      end

      default_name = model.title.to_s.strip
      default_name = 'modelo_modular_3d' if default_name.empty?
      parent = UI.select_directory(title: 'Selecciona dónde preparar el modelo')
      return unless parent

      safe_name = default_name.gsub(/[^0-9A-Za-z_\-]/, '_')
      export_dir = File.join(parent, "#{safe_name}_MODULAR3D_VIEW")
      FileUtils.mkdir_p(export_dir)
      dae_path = File.join(export_dir, "#{safe_name}.dae")
      options = {
        triangulated_faces: true,
        doublesided_faces: true,
        edges: false,
        author_attribution: false,
        texture_maps: true,
        preserve_instancing: true
      }

      Sketchup.set_status_text('Preparando modelo para MODULAR-3D VIEW…')
      success = model.export(dae_path, options)
      Sketchup.set_status_text('')
      unless success
        UI.messagebox('SketchUp no pudo preparar el modelo. Guarda el SKP e inténtalo nuevamente.')
        return
      end

      UI.openURL(VIEW_URL)
      UI.messagebox(
        "Modelo preparado correctamente.\n\n" \
        "En MODULAR-3D VIEW pulsa 'Abrir exportación de SketchUp' y selecciona esta carpeta:\n\n#{export_dir}\n\n" \
        'El archivo SKP original no fue modificado.'
      )
    rescue StandardError => error
      Sketchup.set_status_text('')
      UI.messagebox("No se pudo preparar el modelo:\n#{error.message}")
    end

    unless file_loaded?(__FILE__)
      command = UI::Command.new('Publicar en MODULAR-3D VIEW') { publish }
      command.tooltip = 'Publicar en MODULAR-3D VIEW'
      command.status_bar_text = 'Prepara el modelo abierto para visualizarlo en la web.'
      toolbar = UI::Toolbar.new('MODULAR-3D VIEW')
      toolbar.add_item(command)
      toolbar.show
      UI.menu('Extensions').add_item(command)
      file_loaded(__FILE__)
    end
  end
end
